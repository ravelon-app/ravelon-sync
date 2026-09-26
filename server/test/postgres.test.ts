import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import pg from 'pg';

import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type AppDatabase, lockSection, openDatabase, scalar } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { api, register, syncItem, type TestAccount, type TestServer } from './helpers.js';

/**
 * The same database layer against a real PostgreSQL.
 *
 * Everything else in this suite runs on in-memory SQLite, which serializes
 * transactions on one connection. PostgreSQL serves them from a pool, so
 * placeholder rewriting, BIGINT parsing, rollback and the advisory locks only
 * get exercised here. Runs when TEST_DATABASE_URL is set (CI does), and is
 * skipped otherwise:
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ravelon_test npm test
 *
 * Each run works in a schema of its own and drops it afterwards, so the
 * database can be shared and reruns start clean.
 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const skip = databaseUrl ? false : 'TEST_DATABASE_URL is not set';

// The CI job for PostgreSQL sets this, so a missing URL there fails instead of
// skipping quietly and reporting green for tests that never ran.
if (!databaseUrl && process.env.REQUIRE_TEST_DATABASE === '1') {
  test('TEST_DATABASE_URL is required when REQUIRE_TEST_DATABASE=1', () => {
    assert.fail('TEST_DATABASE_URL is not set');
  });
}

describe('PostgreSQL', { skip }, () => {
  const schema = `ravelon_test_${randomBytes(6).toString('hex')}`;
  const pools: pg.Pool[] = [];
  let db: AppDatabase;

  function schemaPool(): pg.Pool {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 10,
    });
    pools.push(pool);
    return pool;
  }

  before(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    db = await openDatabase({ databaseFile: ':memory:', postgresPool: schemaPool() });
  });

  after(async () => {
    await db?.close();
    await Promise.all(pools.map((pool) => pool.end()));
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  test('migrations apply cleanly, once', async () => {
    assert.equal(db.dialect, 'postgres');
    const applied = await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all<{ name: string }>();
    assert.deepEqual(
      applied.map((row) => row.name).sort(),
      MIGRATIONS.map((migration) => migration.name).sort(),
    );

    // Replicas starting together all run migrate() at once. The advisory lock
    // has to turn that into one run and several no-ops, not a failed start.
    const replicas = await Promise.all(
      [1, 2, 3].map(() => openDatabase({ databaseFile: ':memory:', postgresPool: schemaPool() })),
    );
    await Promise.all(replicas.map((replica) => replica.close()));
    assert.equal(await scalar(db, 'SELECT COUNT(*) AS count FROM schema_migrations'), MIGRATIONS.length);
  });

  test('? placeholders are rewritten outside string literals only', async () => {
    const row = await db.prepare(
      "SELECT '?' AS literal, 'it''s ?' AS escaped, CAST(? AS TEXT) AS first, CAST(? AS TEXT) AS second",
    ).get<{ literal: string; escaped: string; first: string; second: string }>('one', 'two');
    assert.deepEqual(row, { literal: '?', escaped: "it's ?", first: 'one', second: 'two' });
  });

  test('BIGINT and COUNT(*) arrive as numbers', async () => {
    const row = await db.prepare('SELECT CAST(? AS BIGINT) AS big, COUNT(*) AS count FROM schema_migrations')
      .get<{ big: unknown; count: unknown }>(9_007_199_254_740_000);
    assert.equal(typeof row?.big, 'number');
    assert.equal(row?.big, 9_007_199_254_740_000);
    assert.equal(typeof row?.count, 'number');

    const counter = await db.prepare("SELECT value FROM counters WHERE name = 'sync_cursor'")
      .get<{ value: unknown }>();
    assert.equal(typeof counter?.value, 'number');
  });

  test('a failed transaction rolls back everything it wrote', async () => {
    await db.exec('CREATE TABLE tx_probe (id INTEGER PRIMARY KEY)');

    await assert.rejects(
      db.transaction(async () => {
        await db.prepare('INSERT INTO tx_probe (id) VALUES (?)').run(1);
        // A nested call joins the outer transaction instead of committing.
        await db.transaction(async () => {
          await db.prepare('INSERT INTO tx_probe (id) VALUES (?)').run(2);
        })();
        throw new Error('abort');
      })(),
      /abort/,
    );
    assert.equal(await scalar(db, 'SELECT COUNT(*) AS count FROM tx_probe'), 0);

    // A statement error inside the transaction is a rollback too, and the
    // pooled connection must come back usable.
    await assert.rejects(db.transaction(async () => {
      await db.prepare('INSERT INTO tx_probe (id) VALUES (?)').run(3);
      await db.prepare('INSERT INTO tx_probe (id) VALUES (?)').run(3);
    })());
    assert.equal(await scalar(db, 'SELECT COUNT(*) AS count FROM tx_probe'), 0);

    await db.transaction(async () => {
      await db.prepare('INSERT INTO tx_probe (id) VALUES (?)').run(4);
    })();
    assert.equal(await scalar(db, 'SELECT COUNT(*) AS count FROM tx_probe'), 1);
  });

  test('lockSection serializes read-then-write windows across connections', async () => {
    await db.exec('CREATE TABLE lock_probe (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    await db.prepare('INSERT INTO lock_probe (id, n) VALUES (1, 0)').run();

    // Each transaction reads, waits, and writes back what it read plus one.
    // Without the lock, several read the same value and increments are lost.
    const workers = 8;
    await Promise.all(Array.from({ length: workers }, () => db.transaction(async () => {
      await lockSection(db, 'vault_storage');
      const row = await db.prepare('SELECT n FROM lock_probe WHERE id = 1').get<{ n: number }>();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await db.prepare('UPDATE lock_probe SET n = ? WHERE id = 1').run(Number(row?.n) + 1);
    })()));

    assert.equal(await scalar(db, 'SELECT n FROM lock_probe WHERE id = 1'), workers);
  });

  describe('sync over PostgreSQL', () => {
    let server: TestServer;
    let owner: TestAccount;

    before(async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        SYNC_JWT_SECRET: 'test-secret-that-is-long-enough-for-tests-0123456789',
        MFA_ENCRYPTION_KEY: 'test-mfa-key-that-is-long-enough-for-tests-0123456789',
        SETTINGS_ENCRYPTION_KEY: 'test-settings-key-long-enough-for-tests-0123456789',
        RATE_LIMIT_DISABLED: '1',
        WEB_ROOT: '',
        PUBLIC_URL: 'https://sync.test',
      } as NodeJS.ProcessEnv);
      const built = await buildServer(config, db);
      await built.app.ready();
      server = {
        app: built.app,
        db,
        config,
        syncEvents: built.syncEvents,
        close: async () => {
          built.syncEvents.close();
          await built.app.close();
        },
      };
      owner = await register(server, 'postgres@example.com');
    });

    after(async () => {
      await server?.close();
    });

    async function push(vaultId: string, items: Record<string, unknown>[]) {
      return await api(server, 'POST', '/v1/sync/push', {
        token: owner.accessToken,
        body: { vaultId, items },
      });
    }

    test('concurrent pushes to one vault all land, with distinct cursors', async () => {
      const vaultId = 'pg-concurrent-vault';
      assert.equal((await push(vaultId, [syncItem('seed', vaultId)])).status, 200);

      const batches = Array.from({ length: 6 }, (_, batch) =>
        Array.from({ length: 20 }, (_, index) => syncItem(`c-${batch}-${index}`, vaultId)));
      const responses = await Promise.all(batches.map((items) => push(vaultId, items)));

      const revisions = new Set<number>();
      for (const response of responses) {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        for (const result of response.body.results) {
          assert.equal(result.status, 'stored');
          assert.ok(!revisions.has(result.revision), `revision ${result.revision} was handed out twice`);
          revisions.add(result.revision);
        }
      }
      assert.equal(revisions.size, 120);
      assert.equal(
        await scalar(db, 'SELECT COUNT(*) AS count FROM sync_items WHERE vault_id = ?', [vaultId]),
        121,
      );
    });

    test('concurrent first pushes to a new vault id all succeed, creating it once', async () => {
      const vaultId = 'pg-fresh-vault';
      const responses = await Promise.all(Array.from({ length: 4 }, (_, index) =>
        push(vaultId, [syncItem(`fresh-${index}`, vaultId)])));
      for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(await scalar(db, 'SELECT COUNT(*) AS count FROM vaults WHERE id = ?', [vaultId]), 1);
      assert.equal(
        await scalar(db, 'SELECT COUNT(*) AS count FROM sync_items WHERE vault_id = ?', [vaultId]),
        4,
      );
    });

    test('two concurrent creates of one record: one is stored, the other conflicts', async () => {
      const vaultId = 'pg-race-vault';
      assert.equal((await push(vaultId, [syncItem('seed', vaultId)])).status, 200);

      const [first, second] = await Promise.all([
        push(vaultId, [syncItem('contested', vaultId, { baseRevision: 0, clientRevision: 1 })]),
        push(vaultId, [syncItem('contested', vaultId, {
          baseRevision: 0,
          clientRevision: 1,
          ciphertext: syncItem('contested-other', vaultId).ciphertext,
        })]),
      ]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      const statuses = [first.body.results[0].status, second.body.results[0].status].sort();
      assert.deepEqual(statuses, ['conflict', 'stored']);
    });

    test('paging walks the whole vault exactly once, with a cursor that never goes back', async () => {
      const vaultId = 'pg-paging-vault';
      const items = Array.from({ length: 250 }, (_, index) => syncItem(`p-${index}`, vaultId));
      for (let offset = 0; offset < items.length; offset += 100) {
        assert.equal((await push(vaultId, items.slice(offset, offset + 100))).status, 200);
      }

      const seen = new Set<string>();
      let cursor = '0';
      let finished = false;
      for (let page = 0; page < 20 && !finished; page += 1) {
        const response = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=${cursor}`, {
          token: owner.accessToken,
        });
        assert.equal(response.status, 200);
        for (const item of response.body.items) {
          assert.ok(!seen.has(item.id), `${item.id} was delivered twice`);
          seen.add(item.id);
        }
        assert.ok(
          Number(response.body.cursor) >= Number(cursor),
          `cursor went back from ${cursor} to ${response.body.cursor}`,
        );
        cursor = response.body.cursor;
        finished = !response.body.hasMore;
      }
      assert.ok(finished, 'paging did not finish');
      assert.equal(seen.size, 250);

      const again = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=${cursor}`, {
        token: owner.accessToken,
      });
      assert.equal(again.body.items.length, 0);
    });
  });
});
