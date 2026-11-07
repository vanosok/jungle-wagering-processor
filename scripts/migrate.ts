import { connectDatabase } from '../src/infrastructure/database/database';

const db = await connectDatabase();
try {
  if (process.argv[2] === 'down') await db.migrator.down();
  else await db.migrator.up();
} finally {
  await db.close(true);
}
