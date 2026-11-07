import { describe, expect, test } from 'bun:test';
import { DomainError, InvalidTransactionStateError } from '../../src/domain/errors';
import { WalletBalanceChanged } from '../../src/domain/events';
import { type LedgerEntryState, WalletLedgerEntry } from '../../src/domain/ledger';
import { InboxMessage, OutboxMessage } from '../../src/domain/messages';
import { Money } from '../../src/domain/money';
import { type TransactionKind, WagerTransaction } from '../../src/domain/transaction';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
function tx(kind: TransactionKind = 'BET', amount = '10.00', reference?: string) {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: reference,
    createdAt: new Date(),
  });
}

describe('Money', () => {
  test('arithmetic is exact, immutable and fixed scale', () => {
    const a = brl('0.10');
    expect(a.add(brl('0.20')).toString()).toBe('0.30');
    expect(a.toString()).toBe('0.10');
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('1.00').subtract(brl('2.00')).toString()).toBe('-1.00');
    expect(Money.rehydrate({ amount: '-1.00', currency: 'BRL' }).isNegative()).toBe(true);
    expect(brl('999999999999999999.99').toString()).toBe('999999999999999999.99');
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(DomainError);
    expect(brl('1.00').toJSON()).toEqual({ amount: '1.00', currency: 'BRL' });
  });
  for (const amount of [
    '',
    'NaN',
    'Infinity',
    '1e2',
    '1.001',
    '-1.00',
    '1',
    '1.0',
    ' 1.00',
    '01.00',
    '+1.00',
    '1000000000000000000.00',
  ]) {
    test(`rejects invalid input: ${JSON.stringify(amount)}`, () => {
      expect(() => brl(amount)).toThrow(DomainError);
    });
  }
  test('rejects mixed currencies in arithmetic and comparisons', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(DomainError);
    expect(() => brl('1.00').equals(usd)).toThrow(DomainError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(DomainError);
    expect(() => Money.from({ amount: '1.00', currency: 'XYZ' })).toThrow(DomainError);
  });
});

describe('Wallet and ledger', () => {
  test('ledger snapshots cannot be changed through caller-owned state or dates', () => {
    for (const factory of [WalletLedgerEntry.create, WalletLedgerEntry.rehydrate]) {
      const input: LedgerEntryState = {
        id: 'entry',
        walletId: 'wallet',
        transactionId: 'tx',
        direction: 'CREDIT',
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
        walletVersion: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      const entry = factory(input);
      input.createdAt.setUTCFullYear(1999);
      expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      input.walletId = 'another-wallet';
      input.direction = 'DEBIT';
      input.money = brl('2.00');
      entry.createdAt.setUTCFullYear(2000);
      expect(entry.walletId).toBe('wallet');
      expect(entry.direction).toBe('CREDIT');
      expect(entry.money.toString()).toBe('1.00');
      expect(entry.isBalanced()).toBe(true);
      expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }
  });
  test('each movement creates a balanced entry and advances version', () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl('100.00') });
    expect(wallet.version).toBe(1);
    const debit = wallet.debit(brl('80.00'), 'bet');
    expect(debit.isBalanced()).toBe(true);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(() => wallet.debit(brl('80.00'), 'bet2')).toThrow(DomainError);
    expect(wallet.version).toBe(2);
    const credit = wallet.credit(brl('5.00'), 'win');
    expect(credit.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(3);
  });
  test('reversal insufficient funds has a distinct code', () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl('0.00') });
    try {
      wallet.debit(brl('1.00'), 'rollback', true);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    }
  });
  test('invalid ledger arithmetic and negative opening are rejected', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate() }),
    ).toThrow(DomainError);
    expect(() =>
      WalletLedgerEntry.create({
        id: 'l',
        walletId: 'w',
        transactionId: 't',
        direction: 'CREDIT',
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('2.00'),
        walletVersion: 1,
        createdAt: new Date(),
      }),
    ).toThrow(DomainError);
  });
});

describe('WagerTransaction', () => {
  test('kinds have explicit financial directions', () => {
    const bet = tx();
    bet.markProcessed(undefined, new Date());
    const win = tx('WIN');
    win.markProcessed(undefined, new Date());
    expect(bet.ledgerDirectionFor()).toBe('DEBIT');
    expect(win.ledgerDirectionFor()).toBe('CREDIT');
    expect(tx('REFUND', '10.00', 'bet').ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(tx('ROLLBACK', '10.00', 'bet').ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(tx('ROLLBACK', '10.00', 'win').ledgerDirectionFor(win)).toBe('DEBIT');
    expect(tx('LOSS', '0.00').affectsBalance()).toBe(false);
  });
  test('references and full reversal amounts are validated', () => {
    expect(() => tx('REFUND')).toThrow(DomainError);
    expect(() => tx('ROLLBACK')).toThrow(DomainError);
    expect(() => tx('BET', '10.00', 'other')).toThrow(DomainError);
    expect(() => tx('BET', '0.00')).toThrow(DomainError);
    const bet = tx();
    bet.markProcessed(undefined, new Date());
    expect(() => tx('REFUND', '9.00', 'bet').validateReference(bet)).toThrow(DomainError);
    expect(() => tx('REFUND', '10.00', 'bet').validateReference(bet)).not.toThrow();
    const otherWallet = WagerTransaction.rehydrate({
      id: 'id',
      providerId: 'provider-a',
      externalTransactionId: 'ref',
      idempotencyKey: 'key',
      payloadHash: 'h',
      walletId: 'different',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: brl('10.00'),
      createdAt: new Date(),
      status: 'PROCESSED',
    });
    expect(() => tx('REFUND', '10.00', 'ref').validateReference(otherWallet)).toThrow(DomainError);
  });
  test('pending transitions work and every terminal state is irreversible', () => {
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
      const transaction = tx();
      transaction.markPendingReference();
      if (status === 'PROCESSED') transaction.markProcessed('reference', new Date());
      else if (status === 'REJECTED') transaction.reject('INSUFFICIENT_FUNDS');
      else transaction.fail('INFRASTRUCTURE_FAILURE');
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => transaction.markProcessed(undefined, new Date())).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => transaction.reject('INVALID_REFERENCE')).toThrow(InvalidTransactionStateError);
      expect(() => transaction.fail('INFRASTRUCTURE_FAILURE')).toThrow(
        InvalidTransactionStateError,
      );
    }
  });
  test('payload divergence is distinct from a replay', () => {
    expect(tx().matchesPayload('hash')).toBe(true);
    expect(tx().matchesPayload('changed')).toBe(false);
  });
});

describe('Durable messages and events', () => {
  test('inbox completion and outbox backoff are explicit', () => {
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt: new Date(),
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date());
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(new Date())).toThrow(DomainError);
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('100.00') });
    const entry = wallet.debit(brl('10.00'), 't');
    const event = WalletBalanceChanged.from(wallet, entry, { correlationId: 'c' });
    expect(event.toJSON().data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(Object.isFrozen(event.data.money)).toBe(true);
    const outbox = OutboxMessage.enqueue(event);
    const now = new Date();
    outbox.scheduleRetry(now);
    expect(outbox.nextAttemptAt.getTime() - now.getTime()).toBe(1000);
    outbox.scheduleRetry(now);
    expect(outbox.nextAttemptAt.getTime() - now.getTime()).toBe(2000);
    outbox.markPublished(now);
    expect(outbox.isDue(new Date(now.getTime() + 99999))).toBe(false);
  });
});
