import { DomainError, type FailureCode, InvalidTransactionStateError } from './errors';
import type { LedgerDirection } from './ledger';
import type { Money } from './money';

export const publicKinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type TransactionKind = (typeof publicKinds)[number] | 'OPENING';
export type TransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';
export interface TransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: TransactionStatus;
  failureCode?: FailureCode;
  createdAt: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(private readonly state: TransactionState) {}

  static create(
    props: Omit<TransactionState, 'status' | 'failureCode' | 'processedAt'>,
  ): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;
    if ((kind === 'REFUND' || kind === 'ROLLBACK') && !referenceExternalTransactionId) {
      throw new DomainError('INVALID_INPUT', 'Reversals require an external reference');
    }
    if (
      (kind === 'BET' || kind === 'LOSS' || kind === 'OPENING') &&
      referenceExternalTransactionId
    ) {
      throw new DomainError('INVALID_INPUT', 'This operation does not accept a reference');
    }
    if (money.isNegative() || (kind !== 'LOSS' && !money.isPositive())) {
      throw new DomainError('INVALID_INPUT', 'Financial movements must be strictly positive');
    }
    return new WagerTransaction({ ...props, status: 'PENDING' });
  }

  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }
  get id() {
    return this.state.id;
  }
  get providerId() {
    return this.state.providerId;
  }
  get externalTransactionId() {
    return this.state.externalTransactionId;
  }
  get idempotencyKey() {
    return this.state.idempotencyKey;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get walletId() {
    return this.state.walletId;
  }
  get playerId() {
    return this.state.playerId;
  }
  get roundId() {
    return this.state.roundId;
  }
  get gameId() {
    return this.state.gameId;
  }
  get kind() {
    return this.state.kind;
  }
  get money() {
    return this.state.money;
  }
  get referenceExternalTransactionId() {
    return this.state.referenceExternalTransactionId;
  }
  get referenceTransactionId() {
    return this.state.referenceTransactionId;
  }
  get status() {
    return this.state.status;
  }
  get failureCode() {
    return this.state.failureCode;
  }
  get processedAt() {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }

  isTerminal(): boolean {
    return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status);
  }
  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }
  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }
  matchesPayload(hash: string): boolean {
    return hash === this.payloadHash;
  }

  markProcessed(referenceId: string | undefined, at: Date): void {
    this.assertMutable();
    this.state.status = 'PROCESSED';
    this.state.referenceTransactionId = referenceId;
    this.state.processedAt = new Date(at);
  }
  markPendingReference(): void {
    this.assertMutable();
    this.state.status = 'PENDING_REFERENCE';
  }
  reject(code: FailureCode): void {
    this.finish('REJECTED', code);
  }
  fail(code: FailureCode): void {
    this.finish('FAILED', code);
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === 'LOSS')
      throw new DomainError('INVALID_INPUT', 'LOSS has no ledger direction');
    if (this.kind === 'BET') return 'DEBIT';
    if (this.kind !== 'ROLLBACK') return 'CREDIT';
    if (!reference)
      throw new DomainError('INVALID_REFERENCE', 'Rollback requires a resolved reference');
    return reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
  }

  validateReference(reference: WagerTransaction): void {
    if (
      this.providerId !== reference.providerId ||
      this.playerId !== reference.playerId ||
      this.walletId !== reference.walletId ||
      this.roundId !== reference.roundId ||
      this.money.currency !== reference.money.currency
    ) {
      throw new DomainError('INVALID_REFERENCE', 'Reference belongs to another financial context');
    }
    const allowed = this.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
    if (!allowed.includes(reference.kind)) {
      throw new DomainError('INVALID_REFERENCE', 'Reference kind is not allowed');
    }
    if (reference.status !== 'PROCESSED') {
      throw new DomainError('REFERENCE_NOT_PROCESSED', 'Reference must be processed');
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new DomainError('REFERENCE_AMOUNT_MISMATCH', 'Partial reversals are not supported');
    }
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.status);
  }
  private finish(status: 'REJECTED' | 'FAILED', code: FailureCode): void {
    this.assertMutable();
    this.state.status = status;
    this.state.failureCode = code;
    this.state.processedAt = new Date();
  }
}
