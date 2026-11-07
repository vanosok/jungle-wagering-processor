# Architecture and correctness

## Boundaries

`src/domain` contains framework-free classes with private constructors, explicit factories and terminal state transitions. `src/application` coordinates the use cases against `FinancialStore` / `FinancialSession` ports. PostgreSQL, SQS, observability and HTTP are adapters. HTTP and SQS both call `WageringService.submit`.

## Money

`Money` is immutable and represents minor units with `bigint`, with no conversion through JavaScript `number`. API and event values are fixed-scale decimal strings. PostgreSQL stores exact `NUMERIC(20,2)` values; MikroORM maps them as strings and rehydrates through `Money`. Out-of-range arithmetic is rejected, never rounded. Currency is explicit and checked in all arithmetic. The challenge uses two decimal places for all supported ISO currencies; this is a deliberate simplification, not a general-purpose ISO currency scale engine.

## Transactions, ORM and concurrency

MikroORM 6.6 provides a fresh EntityManager / Identity Map per unit of work and `EntityManager.transactional()`. Domain objects are mapped separately from persistence entities. `FlushMode.COMMIT` prevents intermediate reads from flushing a partially assembled financial write. Deferred foreign keys and constraint triggers validate the completed unit at commit, independent of ORM insert ordering.

Lock order is inbox identity (when present), sorted operation identities, then the wallet row with `LockMode.PESSIMISTIC_WRITE` (`SELECT FOR UPDATE`). Advisory locks serialize only identical idempotency / external IDs, including requests with conflicting wallet IDs. Hash collisions can reduce concurrency but cannot weaken correctness. There is no global wallet lock. Distinct wallets remain independently processable. PostgreSQL READ COMMITTED is sufficient because the wallet row lock serializes balance changes. Deadlock / serialization / lock-timeout retries are bounded to three attempts with jitter and a new EntityManager each time.

The database enforces unique wallet ownership per `(player_id, currency)`, global idempotency keys, unique `(provider_id, external_transaction_id)`, and one processed reversal per `(reference_transaction_id, kind)`. Terminal transaction payloads, ledger entries and inbox rows cannot be updated or deleted. Non-negative balances, ledger arithmetic, version progression and deferred balance/ledger consistency are checked in SQL. Deferred ledger checks verify the movement amount, result snapshot and preceding balance. These checks intentionally favor correctness and inspectability over maximum throughput.

## Idempotency

The mandatory HTTP header is authoritative. The canonical payload includes all validated transaction business fields, including a reference when present. Objects are recursively sorted by key, undefined optional fields are omitted, arrays preserve order, and UTF-8 JSON is hashed with SHA-256. Idempotency and transport metadata are excluded. Same key / same hash returns the persisted result, with `idempotentReplay: true`; a different hash is a conflict. Reusing an external transaction ID under a different key is also a conflict. Terminal results retain their original balance snapshot. Pending results may advance to their eventual terminal result.

## Business interpretations

- Financial movements (`BET`, `WIN`, `REFUND`, `ROLLBACK`, internal `OPENING`) must be positive. `LOSS` accepts non-negative money and never moves it.
- Zero initial balance creates a wallet at version 1 without an opening transaction or ledger entry. Positive opening produces both in the same SQL transaction; the initial version remains 1.
- References are provider-scoped external IDs, validated against player, wallet, currency and round. Optional `WIN` references follow the same readiness/context validation and must reference a processed BET. `BET` and `LOSS` do not accept references.
- The uniqueness of reversal is **per kind**, as specified: one REFUND and one ROLLBACK may each reference the same BET. This does not imply a global one-reversal-only policy.
- A valid request against a missing wallet is an auditable business rejection. Consequently wager transactions intentionally do not have a wallet foreign key; financial ledger entries do have composite wallet and transaction foreign keys.
- A currency-mismatch rejection has a null result balance to avoid labeling a wallet balance with the submitted, different currency.
- `PENDING` can transition to `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`. `PENDING_REFERENCE` can remain pending or transition to one of those terminal states, but cannot return to `PENDING`. Terminal states are immutable. Replays do not invoke transitions.

## Authentication scope

Authentication is intentionally omitted within the challenge timebox. HTTP business routes have `ProviderIdentityGuard`, delegating to `ProviderIdentityPort`; the supplied adapter is explicitly a no-op. A production adapter would verify OIDC JWT signature, issuer, audience and expiry using an external IdP (e.g. Keycloak), and bind provider claims / wallet ownership to authorization. Wallet creation, reads, reconciliation and metrics also need an authorization policy before external exposure. Health endpoints remain open. SQS is trusted transport, but provider/domain validation remains mandatory. Reserved `internal:` provider/key namespaces cannot be submitted externally.

## Messaging and crash recovery

The inbox key is `(consumer_name, message_id)`. Its hash includes validated message business data and the idempotency key, excluding envelope timestamps and broker metadata. A new transport ID still passes through financial idempotency; a reused inbox ID with divergent content is a permanent conflict. A business rejection is a successful, committed handling outcome and is acknowledged.

All financial state, ledger entries, incoming inbox records and integration events are persisted in one SQL transaction. The HTTP response and SQS delete happen after `transactional()` returns, which includes the database commit and deferred constraints. A process dying before commit leaves no effects. Dying after commit but before ack causes redelivery and a persistent replay.

The outbox publisher claims up to 10 due rows with `FOR UPDATE SKIP LOCKED` and an atomic 120-second lease. Publication occurs outside the claim transaction. The lease owner condition prevents an expired owner from marking a new owner's claim. The SDK uses two attempts and bounded request timeouts; a failed publish backs off from 1 second to a maximum of 60 seconds. A dead publisher's lease expires for takeover. Events are retried indefinitely with a capped delay because confirmed events must not be discarded; monitor lag and attempts for poison events.

There is an unavoidable uncertainty window when SQS accepts a publish but PostgreSQL has not recorded `published_at`. Retries reuse the **same stored event ID and payload**. FIFO deduplication helps inside its time window; consumers must use durable event-ID deduplication beyond it. This is at-least-once publication, not a claim of exactly-once network delivery. Publishers may deliver events out of order; balance events carry `walletVersion` for downstream ordering/staleness detection.

Reference retries use a scheduled scanner, then reacquire the same identity → wallet lock order as HTTP and re-read status/due time. Competing scanners cannot apply a reference twice. Default schedule: initial delay 1 second, exponential delays capped at 60 seconds, 10 retry attempts (about five minutes before expiry, plus scheduling delay). Exhaustion produces `REJECTED / REFERENCE_EXPIRED` and a rejection event; repeated scans do not re-emit the initial pending event.

**PostgreSQL is the clock authority for persisted retry schedules and outbox leases.** Comparing a database deadline to an application clock can spin or stall workers under clock skew. Due checks, retry calculations and outbox lag therefore use database time; event source timestamps remain informational. Ledger ordering uses wallet version rather than wall-clock timestamps.

The consumer long-polls SQS, processes distinct message groups concurrently and preserves sequential handling inside a received group. Visibility is extended while handling. Transient infrastructure failures use visibility backoff (2 seconds initially, cap 60 seconds); default maximum receives is 5, with both a broker redrive policy and explicit application DLQ routing. Malformed envelopes and immutable identity conflicts go directly to DLQ. A DLQ send is confirmed before deleting the source, and has a stable deduplication ID derived from the original SQS message.

On exhausted infrastructure retries, a valid request is recorded as `FAILED / INFRASTRUCTURE_FAILURE` with an inbox record and `WagerTransactionFailed` event if PostgreSQL is writable. An already committed transaction is replayed, never changed to FAILED because an acknowledgement failed. If the database remains unavailable, the original DLQ envelope is the durable audit and recovery source; the system cannot truthfully claim a SQL audit record was written during a database outage. Operators should inspect the stable failure code, repair the cause, and deliberately replay with the original business identities. A terminal FAILED record requires an explicit business recovery decision, not silent reapplication.

## HTTP, observability and shutdown

Transport validation rejects unknown fields, malformed UUIDs, reserved internal identities, scientific notation and amounts without exactly two decimal places. Business-valid requests can be terminally rejected with a stable machine code. HTTP separates invalid input (400), identity conflicts (409), business rejections (422), pending references (202), transient infrastructure (503) and permanent/internal failures (500). Creation uses 201 and reads use 200/404.

Logs use an allowlist of IDs and codes; raw requests, financial amounts and SDK exceptions are not logged. Metrics are per process and need scraping for each replica. Submission/retry outcome counters include replays; the duplicate counter identifies those explicitly. SQL terminal records remain the audit source of truth. Outbox lag uses a database-generated `enqueued_at`, avoiding clock skew in event source timestamps. Reconciliation uses one SQL statement and therefore a single MVCC snapshot for both stored and reconstructed balance.

On SIGTERM/SIGINT readiness stops reporting ready, long polling is aborted, new consumer work stops, and in-flight handlers/publishers get up to 30 seconds to finish. Unstarted received messages have visibility returned to zero. If the drain deadline is exceeded, active handles have visibility returned before database/client closure. Abrupt death remains safe through inbox idempotency and outbox leases. Compose allows 40 seconds before forced termination. HTTP server closure drains active requests before closing PostgreSQL.

## Stable pagination

Ledger cursors encode a versioned wallet-specific `(afterVersion, ceilingVersion)` snapshot. The immutable per-wallet version orders entries without timestamp ties. New ledger entries after the first page are excluded from that pagination session; start a fresh session to see them. Limit is 1–100, default 50. Cursors are opaque to clients, validated for type/bounds and wallet identity, and are not authorization tokens.

## Failure-code taxonomy

| Code | Meaning / caller action |
|---|---|
| `INVALID_INPUT` | Correct contract, amount, identifiers or required reference before resubmitting |
| `IDEMPOTENCY_CONFLICT` | Do not reuse the same key for another payload |
| `EXTERNAL_ID_CONFLICT` | External transaction already belongs to another key; use original identity |
| `INBOX_CONFLICT` | A message ID was reused with divergent content; investigate sender |
| `WALLET_EXISTS` | Query existing wallet instead of creating another |
| `WALLET_NOT_FOUND`, `PLAYER_MISMATCH`, `CURRENCY_MISMATCH` | Correct ownership/currency context; a terminal rejection will replay |
| `INSUFFICIENT_FUNDS` | BET rejected; retrying the same identity preserves the rejection |
| `REVERSAL_INSUFFICIENT_FUNDS` | A reversal would overdraw the wallet; operational/business intervention needed |
| `INVALID_REFERENCE`, `REFERENCE_NOT_PROCESSED` | Correct kind/context or reference terminal status |
| `REFERENCE_AMOUNT_MISMATCH` | Reversals must equal the full original amount |
| `ALREADY_REVERSED` | Reference already reversed by this kind; no additional movement |
| `REFERENCE_EXPIRED` | Reference unavailable after bounded retries; investigate ordering/missing operation |
| `INFRASTRUCTURE_FAILURE` | Permanent audited failure after infrastructure retry exhaustion |
| `INFRASTRUCTURE_UNAVAILABLE` | HTTP transport code: retry original identity after recovery |
| `NOT_FOUND` | Query target does not exist |

Pending-reference acceptance is not a failure. A terminal rejection must not be mutated merely because funds/reference availability later changes. New corrected business operations require new external IDs and keys under the provider's recovery policy.

## Trade-offs and limitations

- Deferred full-ledger reconciliation on balance mutations adds work proportional to wallet history. It is a correctness-first guard for this challenge; a production design would benchmark it and consider an incrementally verifiable accounting design plus independent reconciliation. No throughput/RPS target or benchmark result is claimed.
- This is a single-wallet signed ledger, not double-entry bookkeeping. There is no cross-wallet transfer or partial reversal.
- Domain constructors / factories enforce encapsulation; PostgreSQL triggers provide the persistence backstop. The local database user owns its schema for reproducible migrations/tests. Production should separate migration ownership and a least-privilege application role; a superuser can bypass any trigger-based design.
- Outbox/inbox and terminal records have no automatic retention/deletion policy. This deliberately favors audit and safe replay over bounded disk usage. Production requires retention, archival and backup policy coordinated with provider replay horizons.
- A failed/rejected transaction is terminal. Recovery is explicit; no administrative endpoint silently rewrites financial history.
- LocalStack queues are ephemeral in the supplied local stack. SQL outbox state survives process restarts, but a broker data loss **after publication acknowledgement** is outside the process-crash guarantee. Actual AWS SQS supplies broker durability; local persistence or backup is an operational concern.
- Authentication, OIDC integration, distributed traces, a dashboard, double-entry accounting and load testing are not implemented. Health, metrics, failure codes and correctness/recovery tests are included.
- Dependency versions and images are pinned for reproducibility rather than selected dynamically at startup. CI is provided but a remote CI success is not implied by local runs.

## Verification

`bun run test:all` runs strict type checking, lint, domain tests and real-container integration tests. The integration runner provisions a fresh database and queue namespace, exercises both migrations in both directions, and cleans only its resources. Three real Bun/NestJS processes handle the same wallet, a worker is killed with SIGKILL at the post-commit/pre-ack boundary, and concurrent publishers use real SQS. Failure injection covers rollback before commit and the uncertain publish/mark window. Mocked financial databases/brokers do not replace the integration environment; adapters are wrapped only to inject targeted failures while the real database and SQS remain in use.

Test wait deadlines use monotonic `performance.now()` so host/VM wall-clock corrections cannot prematurely end recovery assertions. Persisted production schedules independently use the PostgreSQL clock.
