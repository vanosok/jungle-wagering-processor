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

Messaging recovery, operational configuration and test evidence are documented with the corresponding adapters.
