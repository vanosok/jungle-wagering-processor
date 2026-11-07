import { afterAll, beforeAll, expect, test } from 'bun:test';
import { WageringService } from '../../src/application/wagering';
import { connectDatabase, type Database } from '../../src/infrastructure/database/database';
import { Queries } from '../../src/infrastructure/database/queries';
import { PostgresFinancialStore } from '../../src/infrastructure/database/store';

let db: Database;
let service: WageringService;
beforeAll(async () => {
  db = await connectDatabase();
  service = new WageringService(new PostgresFinancialStore(db));
});
afterAll(async () => {
  await db?.close(true);
});
test('double-entry journal is balanced, immutable and reconciles to wallet movements', async () => {
  const wallet = await service.openWallet(
    { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    { correlationId: 'journal-test' },
  );
  const provider = crypto.randomUUID();
  for (const kind of ['BET', 'WIN', 'LOSS']) {
    await service.submit(
      {
        providerId: provider,
        externalTransactionId: crypto.randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind,
        gameId: 'game',
        roundId: 'round',
        money: { amount: '10.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
      { correlationId: 'journal-test' },
    );
  }
  const check = await new Queries(db).reconcile(wallet.id, 'journal-test');
  expect(check).toMatchObject({
    consistent: true,
    checkedEntries: 3,
    doubleEntry: {
      consistent: true,
      checkedPostings: 6,
      debits: { amount: '120.00' },
      credits: { amount: '120.00' },
    },
  });
  const [row] = await db.em
    .fork()
    .execute<{ id: string }[]>(
      `select p.id from journal_postings p join wallet_ledger l on l.id = p.ledger_id where l.wallet_id = ? limit 1`,
      [wallet.id],
    );
  let failure: unknown;
  try {
    await db.em.fork().execute('update journal_postings set amount = 1 where id = ?', [row?.id]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
});
test('database refuses otherwise valid financial commits with missing or wrong-account postings', async () => {
  const wallet = await service.openWallet(
    { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    { correlationId: 'journal-test' },
  );
  for (const injectWrongAccounts of [false, true]) {
    let failure: unknown;
    try {
      await db.em.fork().transactional(async (em) => {
        const transaction = crypto.randomUUID();
        const ledger = crypto.randomUUID();
        await em.execute(
          `insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
          wallet_id,player_id,round_id,game_id,kind,amount,currency,status,result_balance,attempts,correlation_id,created_at,processed_at)
          values(?, 'journal-test', ?, ?, 'hash', ?, ?, 'round','game','BET','10.00','BRL','PROCESSED','90.00',0,'journal-test',now(),now())`,
          [transaction, transaction, transaction, wallet.id, wallet.playerId],
        );
        await em.execute("update wallets set balance = '90.00',version = 2 where id = ?", [
          wallet.id,
        ]);
        await em.execute(
          `insert into wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
          values(?,?,?,'DEBIT','10.00','BRL','100.00','90.00',2,now())`,
          [ledger, wallet.id, transaction],
        );
        if (injectWrongAccounts)
          await em.execute(
            `insert into journal_postings(id,ledger_id,account,side,amount,currency)
          values(gen_random_uuid(),?,'wrong-wallet','DEBIT','10.00','BRL'),(gen_random_uuid(),?,'wrong-clearing','CREDIT','10.00','BRL')`,
            [ledger, ledger],
          );
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toContain('journal');
    expect(await new Queries(db).reconcile(wallet.id, 'journal-test')).toMatchObject({
      consistent: true,
      storedBalance: { amount: '100.00' },
      doubleEntry: { checkedPostings: 2 },
    });
  }
});
