export type FailureCode =
  | 'INVALID_INPUT'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'WALLET_NOT_FOUND'
  | 'PLAYER_MISMATCH'
  | 'INVALID_REFERENCE'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_EXPIRED'
  | 'REFERENCE_AMOUNT_MISMATCH'
  | 'ALREADY_REVERSED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXTERNAL_ID_CONFLICT'
  | 'INBOX_CONFLICT'
  | 'WALLET_EXISTS'
  | 'NOT_FOUND'
  | 'INFRASTRUCTURE_FAILURE';

export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: string) {
    super(`Cannot transition terminal transaction: ${status}`);
    this.name = 'InvalidTransactionStateError';
  }
}
