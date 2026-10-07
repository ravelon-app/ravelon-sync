import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { Pool, type PoolClient, type QueryResultRow, types as pgTypes } from 'pg';

import { nowIso } from '../config.js';
import { MIGRATIONS } from './migrations.js';

export interface RunResult {
  changes: number;
}

export interface Statement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export interface AppDatabase {
  readonly dialect: 'postgres' | 'sqlite';
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  transaction<TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult>;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  databaseUrl?: string;
  databaseFile: string;
  /** Injectable pool for tests and embedded hosts. */
  postgresPool?: Pool;
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<AppDatabase> {
  const db: AppDatabase =
    options.databaseUrl || options.postgresPool
      ? new PostgresDatabase(options.databaseUrl, options.postgresPool)
      : new SqliteDatabase(options.databaseFile);
  try {
    await migrate(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

/**
 * Applies pending migrations under an advisory lock, so several replicas
 * starting at once cannot race each other through the same schema change.
 */
async function migrate(db: AppDatabase): Promise<void> {
  const migrationLock = 1_882_037_052;
  if (db.dialect === 'postgres') {
    await db.prepare('SELECT pg_advisory_lock(?)').get(migrationLock);
  }
  try {
    await db
      .prepare(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
      )
      .run();

    for (const migration of MIGRATIONS) {
      const applied = await db
        .prepare('SELECT name FROM schema_migrations WHERE name = ?')
        .get(migration.name);
      if (applied) continue;
      await db.transaction(async () => {
        await db.exec(migration.sql);
        await db
          .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run(migration.name, nowIso());
      })();
    }
  } finally {
    if (db.dialect === 'postgres') {
      await db.prepare('SELECT pg_advisory_unlock(?)').get(migrationLock);
    }
  }
}

class SqliteDatabase implements AppDatabase {
  readonly dialect = 'sqlite' as const;
  readonly #db: BetterSqlite3.Database;
  readonly #transaction = new AsyncLocalStorage<boolean>();
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.#db = new BetterSqlite3(file);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.pragma('busy_timeout = 5000');
  }

  prepare(sql: string): Statement {
    const statement = this.#db.prepare(sql);
    return {
      get: async <T>(...params: unknown[]) => statement.get(...(params as never[])) as T | undefined,
      all: async <T>(...params: unknown[]) => statement.all(...(params as never[])) as T[],
      run: async (...params: unknown[]) => ({
        changes: Number(statement.run(...(params as never[])).changes),
      }),
    };
  }

  async exec(sql: string): Promise<void> {
    this.#db.exec(sql);
  }

  /**
   * better-sqlite3 is synchronous and has one connection, so an await inside a
   * transaction could interleave another transaction onto the same connection.
   * Transactions are therefore serialized through a tail promise, and a nested
   * call joins the transaction already in progress instead of opening another.
   */
  transaction<TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs) => {
      if (this.#transaction.getStore()) return operation(...args);

      let releaseTransaction!: () => void;
      const previousTransaction = this.#transactionTail;
      this.#transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previousTransaction;

      let began = false;
      try {
        this.#db.exec('BEGIN IMMEDIATE');
        began = true;
        const result = await this.#transaction.run(true, () => operation(...args));
        this.#db.exec('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try {
            this.#db.exec('ROLLBACK');
          } catch {
            // A failed rollback means the transaction is already closed.
          }
        }
        throw error;
      } finally {
        releaseTransaction();
      }
    };
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

class PostgresDatabase implements AppDatabase {
  readonly dialect = 'postgres' as const;
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #client = new AsyncLocalStorage<PoolClient>();

  constructor(connectionString?: string, pool?: Pool) {
    // BIGINT arrives as a string by default. Cursors and revisions stay well
    // inside Number.MAX_SAFE_INTEGER, and the rest of the code compares them
    // numerically, so they are parsed here once.
    pgTypes.setTypeParser(pgTypes.builtins.INT8, (value: string) => Number(value));
    this.#ownsPool = !pool;
    this.#pool = pool ?? new Pool({ connectionString, max: 10 });
  }

  prepare(sql: string): Statement {
    const text = toPositionalParameters(sql);
    const query = async <T extends QueryResultRow>(params: unknown[]) => {
      const client = this.#client.getStore();
      if (client) return await client.query<T>(text, params);
      return await this.#pool.query<T>(text, params);
    };
    return {
      get: async <T>(...params: unknown[]) => (await query(params)).rows[0] as T | undefined,
      all: async <T>(...params: unknown[]) => (await query(params)).rows as T[],
      run: async (...params: unknown[]) => ({ changes: (await query(params)).rowCount ?? 0 }),
    };
  }

  async exec(sql: string): Promise<void> {
    const client = this.#client.getStore();
    if (client) {
      await client.query(sql);
      return;
    }
    await this.#pool.query(sql);
  }

  transaction<TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs) => {
      if (this.#client.getStore()) return operation(...args);
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN');
        const result = await this.#client.run(client, () => operation(...args));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Already rolled back or the connection is gone.
        }
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}

/** Rewrites `?` placeholders into PostgreSQL's `$1, $2, ...` form. */
function toPositionalParameters(sql: string): string {
  let index = 0;
  let inSingleQuote = false;
  let output = '';
  for (let position = 0; position < sql.length; position += 1) {
    const character = sql[position];
    if (character === "'") inSingleQuote = !inSingleQuote;
    if (character === '?' && !inSingleQuote) {
      index += 1;
      output += `$${index}`;
      continue;
    }
    output += character;
  }
  return output;
}

/**
 * Serializes a critical section across connections, for the duration of the
 * surrounding transaction.
 *
 * SQLite needs nothing: this layer runs transactions one at a time on a single
 * connection. PostgreSQL serves them from a pool, so two requests can reach
 * the same read-then-write window at once and both act on what they read.
 *
 * Must be called inside a transaction. The lock is released on commit or
 * rollback, so a failed request cannot hold it.
 */
export async function lockSection(db: AppDatabase, name: LockName): Promise<void> {
  if (db.dialect !== 'postgres') return;
  await db.prepare('SELECT pg_advisory_xact_lock(?)').get(LOCK_IDS[name]);
}

export type LockName = 'user_bootstrap' | 'vault_storage' | 'vault_create';

/** Arbitrary but fixed. Two different sections must never share a number. */
const LOCK_IDS: Record<LockName, number> = {
  user_bootstrap: 1_882_037_101,
  vault_storage: 1_882_037_102,
  vault_create: 1_882_037_103,
};

/** Reads a single numeric aggregate, normalizing SQLite and PostgreSQL types. */
export async function scalar(db: AppDatabase, sql: string, params: unknown[] = []): Promise<number> {
  const row = (await db.prepare(sql).get(...params)) as Record<string, unknown> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return Number(value ?? 0);
}
