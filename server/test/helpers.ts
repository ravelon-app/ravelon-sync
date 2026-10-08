import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { type AppDatabase, openDatabase } from '../src/db/database.js';
import type { SyncEventHub } from '../src/lib/sync-events.js';

export interface TestServer {
  app: FastifyInstance;
  db: AppDatabase;
  config: Config;
  syncEvents: SyncEventHub;
  close(): Promise<void>;
}

/**
 * An in-memory server per test.
 *
 * SQLite `:memory:` means no file to clean up and no state shared between
 * tests, so ordering never matters. Rate limits are off because the suite
 * makes many requests from one address on purpose.
 */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_FILE: ':memory:',
    SYNC_JWT_SECRET: 'test-secret-that-is-long-enough-for-tests-0123456789',
    MFA_ENCRYPTION_KEY: 'test-mfa-key-that-is-long-enough-for-tests-0123456789',
    SETTINGS_ENCRYPTION_KEY: 'test-settings-key-long-enough-for-tests-0123456789',
    RATE_LIMIT_DISABLED: '1',
    WEB_ROOT: '',
    PUBLIC_URL: 'https://sync.test',
    ...env,
  } as NodeJS.ProcessEnv);

  const db = await openDatabase({ databaseFile: ':memory:' });
  const built = await buildServer(config, db);
  await built.app.ready();

  return {
    app: built.app,
    db,
    config,
    syncEvents: built.syncEvents,
    close: async () => {
      built.syncEvents.close();
      await built.app.close();
      await db.close();
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  server: TestServer,
  method: string,
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const response = await server.app.inject({
    method: method as 'GET',
    url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    payload: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body: unknown = null;
  if (response.body) {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  }
  return { status: response.statusCode, body: body as T };
}

export interface TestAccount {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

/** Registers an account. The first one in a fresh deployment is its administrator. */
export async function register(
  server: TestServer,
  email: string,
  options: { password?: string; inviteToken?: string; deviceName?: string } = {},
): Promise<TestAccount> {
  const password = options.password ?? 'correct-horse-battery-staple';
  const response = await api(server, 'POST', '/v1/auth/register', {
    body: {
      email,
      password,
      deviceName: options.deviceName ?? 'Test Device',
      platform: 'test',
      ...(options.inviteToken ? { inviteToken: options.inviteToken } : {}),
    },
  });
  if (response.status !== 201) {
    throw new Error(`register failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return {
    userId: response.body.userId,
    email,
    password,
    accessToken: response.body.accessToken,
    refreshToken: response.body.refreshToken,
    deviceId: response.body.deviceId,
  };
}

export async function login(
  server: TestServer,
  email: string,
  password: string,
  extra: Record<string, unknown> = {},
): Promise<ApiResponse> {
  return await api(server, 'POST', '/v1/auth/login', {
    body: { email, password, deviceName: 'Test Device', platform: 'test', mfaSupported: true, ...extra },
  });
}

/**
 * A payload that passes the plaintext guard.
 *
 * The server refuses anything that decodes to readable JSON, so tests need a
 * value that looks like real ciphertext rather than a placeholder string.
 */
export function fakeCiphertext(seed: string): string {
  const bytes = Buffer.alloc(48);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed.charCodeAt(index % seed.length) * 31 + index * 97) % 256;
  }
  return `b64:${bytes.toString('base64')}`;
}

export function fakeNonce(seed = 'nonce'): string {
  const bytes = Buffer.alloc(24);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed.charCodeAt(index % seed.length) * 17 + index * 13) % 256;
  }
  return bytes.toString('base64');
}

export function syncItem(
  id: string,
  vaultId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    vaultId,
    itemType: 'Host',
    ciphertext: fakeCiphertext(id),
    nonce: fakeNonce(id),
    schemaVersion: 1,
    clientRevision: 1,
    updatedAt: '2026-01-01T12:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}
