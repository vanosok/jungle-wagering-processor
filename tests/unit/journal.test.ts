import { expect, test } from 'bun:test';
import { Journal } from '../../src/domain/journal';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

test('wallet liability debit has an equal clearing credit and vice versa', () => {
  const wallet = Wallet.open({
    id: 'w',
    playerId: 'p',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  const bet = Journal.from(wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), 'bet'));
  expect(bet.isBalanced()).toBe(true);
  expect(bet.postings.map((p) => [p.account, p.side, p.money.toString()])).toEqual([
    ['wallet:w', 'DEBIT', '25.00'],
    ['clearing:BRL', 'CREDIT', '25.00'],
  ]);
  const win = Journal.from(wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }), 'win'));
  expect(win.postings[0]?.side).toBe('CREDIT');
  expect(win.postings[1]?.side).toBe('DEBIT');
  expect(Object.isFrozen(win.postings[0])).toBe(true);
});
