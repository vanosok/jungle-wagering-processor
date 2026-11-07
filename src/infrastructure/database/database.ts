import { FlushMode } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../../config';
import { entities } from './entities';
import { Migration202611070001 } from './migrations/Migration202611070001';
import { Migration202611070002 } from './migrations/Migration202611070002';

export async function connectDatabase(url = config.DATABASE_URL) {
  return MikroORM.init({
    clientUrl: url,
    entities,
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration202611070001, Migration202611070002],
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 0, max: 12, acquireTimeoutMillis: 3000 },
    flushMode: FlushMode.COMMIT,
    driverOptions: {
      connection: { statement_timeout: 10000, lock_timeout: 3000, connectionTimeoutMillis: 2000 },
    },
  });
}
export type Database = Awaited<ReturnType<typeof connectDatabase>>;
