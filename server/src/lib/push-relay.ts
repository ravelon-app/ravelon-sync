import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ApiError } from './errors.js';

export const canonicalHostId = z.uuid().regex(/^[0-9a-f-]+$/);
export const pushRegistration = z
  .object({
    token: z.string().regex(/^[a-fA-F0-9]{64,512}$/),
    platform: z.literal('ios'),
    environment: z.enum(['development', 'production']),
    topic: z.literal('app.ravelon.ios'),
    agentAlerts: z.boolean().optional().default(false),
  })
  .strict();
const sealedRef = z
  .string()
  .min(40)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= 28 && bytes.toString('base64url') === value;
  }, 'Invalid sealed reference');
export const attentionBody = z
  .object({
    v: z.literal(1),
    event: z.enum(['approval', 'input', 'planReady', 'failed', 'completed']),
    ref: sealedRef,
    excludedDeviceIds: z
      .array(canonicalHostId)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
export type AttentionEvent = Omit<z.infer<typeof attentionBody>, 'excludedDeviceIds'> & {
  type: 'agentAttention';
  hostId: string;
};
export type RelayEvent = AttentionEvent | { type: 'vaultChanged'; cursor: string };
export interface PushDevice {
  id: string;
  user_id: string;
  device_id: string;
  token: string;
  token_hash: string;
  environment: 'development' | 'production';
  topic: string;
  agent_alerts: number;
  expires_at: string;
}

/** Holds only device transport metadata; never agent text or plaintext thread references. */
export class PushRelay {
  constructor(
    readonly db: AppDatabase,
    readonly config: NonNullable<Config['pushRelay']>,
    readonly transport: typeof fetch = fetch,
  ) {}

  async request(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.transport(`${this.config.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw this.failure();
    }
    if (!response.ok) {
      const error = this.failure(response.status === 429 ? 429 : 503);
      const seconds = Number(response.headers.get('retry-after'));
      if (Number.isFinite(seconds) && seconds > 0)
        error.retryAfterSeconds = Math.min(3600, Math.max(1, Math.ceil(seconds)));
      // Do not include an upstream body, URL, token or sealed reference in logs/errors.
      await response.body?.cancel();
      throw error;
    }
    return response;
  }

  failure(status = 503): ApiError {
    const error = new ApiError(status, 'push_relay_unavailable', 'Try again shortly');
    error.retryAfterSeconds = 10;
    return error;
  }

  async queueRemoval(row: Pick<PushDevice, 'id' | 'token'>): Promise<void> {
    await this.db
      .prepare('INSERT INTO push_relay_removals (id, token) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run(row.id, row.token);
    await this.db.prepare('DELETE FROM push_devices WHERE id = ? AND token = ?').run(row.id, row.token);
  }

  async cleanup(): Promise<void> {
    const stale = await this.db
      .prepare(`SELECT p.id, p.token FROM push_devices p
      WHERE p.expires_at <= ? OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND u.disabled = 0)
      OR NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.user_id = p.user_id AND r.device_id = p.device_id AND r.revoked_at IS NULL AND r.expires_at > ?)`)
      .all<PushDevice>(nowIso(), nowIso());
    for (const row of stale) await this.db.transaction(() => this.queueRemoval(row))();
    const removals = await this.db
      .prepare('SELECT id, token FROM push_relay_removals ORDER BY id LIMIT 100')
      .all<PushDevice>();
    for (const row of removals) {
      try {
        const response = await this.request(`/v1/relay/subscriptions/${row.id}`, 'DELETE', {
          token: row.token,
        });
        await response.body?.cancel();
        await this.db
          .prepare('DELETE FROM push_relay_removals WHERE id = ? AND token = ?')
          .run(row.id, row.token);
      } catch {
        /* Persist for the next maintenance tick or request. */
      }
    }
  }

  async register(
    userId: string,
    deviceId: string,
    input: z.infer<typeof pushRegistration>,
    revalidate: () => Promise<unknown>,
  ): Promise<void> {
    const id = `rps_${randomBytes(16).toString('hex')}`;
    const token = input.token.toLowerCase();
    const row = await this.db.transaction(async () => {
      await revalidate();
      const live = await this.db
        .prepare(
          'SELECT MAX(expires_at) AS expires_at FROM refresh_tokens WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL AND expires_at > ?',
        )
        .get<{ expires_at: string | null }>(userId, deviceId, nowIso());
      if (!live?.expires_at) throw new ApiError(401, 'device_revoked', 'This device was signed out');
      const previous = await this.db
        .prepare('SELECT id, token FROM push_devices WHERE token_hash = ? OR (user_id = ? AND device_id = ?)')
        .all<PushDevice>(createHash('sha256').update(token).digest('hex'), userId, deviceId);
      for (const old of previous) await this.queueRemoval(old);
      const expiresAt = new Date(
        Math.min(Date.parse(live.expires_at), Date.now() + 60 * 24 * 60 * 60 * 1000),
      ).toISOString();
      await this.db
        .prepare(`INSERT INTO push_devices (id, user_id, device_id, token, token_hash, environment, topic, agent_alerts, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          userId,
          deviceId,
          token,
          createHash('sha256').update(token).digest('hex'),
          input.environment,
          input.topic,
          Number(input.agentAlerts),
          expiresAt,
          nowIso(),
        );
      return { id, token, expiresAt };
    })();
    try {
      const response = await this.request('/v1/relay/subscriptions', 'POST', {
        subscriptionId: id,
        token,
        environment: input.environment,
        topic: input.topic,
        agentAlerts: input.agentAlerts,
        expiresAt: row.expiresAt,
      });
      const result = z.object({ registered: z.literal(true) }).parse(await response.json());
      if (!result.registered) throw this.failure();
      await revalidate();
      const changed = await this.db
        .prepare(
          'UPDATE push_devices SET registered = 1 WHERE id = ? AND user_id = ? AND device_id = ? AND token = ?',
        )
        .run(id, userId, deviceId, token);
      if (!changed.changes) throw new ApiError(409, 'registration_changed', 'Try again');
    } catch (error) {
      await this.db.transaction(() => this.queueRemoval(row))();
      await this.cleanup();
      if (error instanceof ApiError) throw error;
      throw this.failure();
    }
    await this.cleanup();
  }

  async remove(userId: string, deviceId: string): Promise<void> {
    await this.db.transaction(async () => {
      const rows = await this.db
        .prepare('SELECT id, token FROM push_devices WHERE user_id = ? AND device_id = ?')
        .all<PushDevice>(userId, deviceId);
      for (const row of rows) await this.queueRemoval(row);
    })();
    await this.cleanup();
  }

  async select(userId: string, alert: boolean, excludedDeviceIds: string[] = []): Promise<PushDevice[]> {
    return this.db
      .prepare(`SELECT p.* FROM push_devices p JOIN devices d ON d.id = p.device_id AND d.user_id = p.user_id
      JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.disabled = 0 AND p.registered = 1 AND p.expires_at > ?
      ${alert ? 'AND p.agent_alerts = 1' : ''} ${excludedDeviceIds.length ? `AND p.device_id NOT IN (${excludedDeviceIds.map(() => '?').join(',')})` : ''}
      AND EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.user_id = p.user_id AND r.device_id = p.device_id AND r.revoked_at IS NULL AND r.expires_at > ?)`)
      .all<PushDevice>(userId, nowIso(), ...excludedDeviceIds, nowIso());
  }

  async wake(devices: PushDevice[], event: RelayEvent): Promise<number> {
    if (!devices.length) return 0;
    const response = await this.request('/v1/relay/wake', 'POST', {
      subscriptionIds: devices.map((d) => d.id),
      event,
    });
    try {
      return z.object({ accepted: z.number().int().min(0).max(devices.length) }).parse(await response.json())
        .accepted;
    } catch {
      throw this.failure();
    }
  }

  async vaultChanged(vaultId: string, sourceDeviceId: string, cursor: string): Promise<void> {
    const members = await this.db
      .prepare('SELECT user_id FROM vault_members WHERE vault_id = ?')
      .all<{ user_id: string }>(vaultId);
    const devices: PushDevice[] = [];
    for (const member of members)
      devices.push(...(await this.select(member.user_id, false, [sourceDeviceId])));
    await this.wake(devices, { type: 'vaultChanged', cursor });
  }
}
