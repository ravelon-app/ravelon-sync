import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { openDatabase } from '../../src/db/database.js';

/** Optional real-PostgreSQL run, always in a task-owned schema. No .env is loaded. */
export async function pushTestDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  const schema = `push_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, max: 3, options: `-c search_path=${schema}` });
  try {
    const database = await openDatabase({ databaseFile: ':memory:', postgresPool: pool });
    return {
      database,
      cleanup: async () => {
        // Self-hosted DB wrappers preserve externally supplied pools; this fixture owns it.
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
}
