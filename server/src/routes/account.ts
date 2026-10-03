import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { nowIso } from '../config.js';
import {
  countUnusedRecoveryCodes,
  confirmTotpEnrollment,
  disableMfa,
  getUserMfa,
  isMfaEnabled,
  regenerateRecoveryCodes,
  startTotpEnrollment,
} from '../auth/mfa.js';
import { generateTotpSecret, totpUri } from '../auth/totp.js';
import { verifyReauth } from '../auth/reauth.js';
import { LIVE_DEVICE_SQL, requireAuth, revokeAllSessions } from '../auth/sessions.js';
import { assertOwnsNoTeams, deleteAccount } from '../lib/accounts.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { DeviceRow } from '../lib/rows.js';
import { readSetting } from '../lib/settings.js';
import { listAccessibleVaults, publicVault } from '../lib/vaults.js';
import {
  clientIp,
  displayNameSchema,
  emailVerificationRequired,
  mfaCodeSchema,
  type RouteContext,
} from './context.js';
import { publicUser } from './auth.js';

/**
 * MFA changes and account deletion need proof the person at the keyboard is
 * the account holder right now, not just whoever holds a live access token.
 */
const reauthSchema = z.object({
  password: z.string().min(1).max(512),
  mfaCode: mfaCodeSchema.optional(),
});

export function registerAccountRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, limiter } = context;

  /**
   * The bundle every Ravelon client fetches after signing in.
   *
   * `entitlements.canSync` exists because the desktop and iOS clients read it
   * to decide whether sync is available. On a self-hosted server it is true
   * unless the operator requires a verified email address.
   */
  app.get('/v1/account/me', async (request) => {
    const auth = await requireAuth(db, config, request);
    return await accountBundle(context, auth.user.id);
  });

  app.patch('/v1/account', async (request) => {
    const auth = await requireAuth(db, config, request);
    const body = z.object({
      displayName: displayNameSchema.nullable().optional(),
    }).parse(request.body);

    if (body.displayName !== undefined) {
      await db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
        .run(body.displayName?.trim() || null, nowIso(), auth.user.id);
    }
    return await accountBundle(context, auth.user.id);
  });

  app.get('/v1/account/mfa', async (request) => {
    const auth = await requireAuth(db, config, request);
    const mfa = await getUserMfa(db, auth.user.id);
    return {
      enabled: Boolean(mfa?.totp_secret_encrypted && mfa.totp_confirmed_at),
      pending: Boolean(mfa?.totp_secret_encrypted && !mfa.totp_confirmed_at),
      confirmedAt: mfa?.totp_confirmed_at ?? null,
      recoveryCodesRemaining: await countUnusedRecoveryCodes(db, auth.user.id),
    };
  });

  app.post('/v1/account/mfa/totp/setup', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`mfa-setup:${auth.user.id}`, 10);
    await requireReauth(context, request, auth.user.id, auth.user.password_hash);
    if (await isMfaEnabled(db, auth.user.id)) {
      throw new ApiError(409, 'mfa_already_enabled', 'An authenticator is already enrolled');
    }

    const secret = generateTotpSecret();
    await startTotpEnrollment(db, config, auth.user.id, secret);
    const platform = await readSetting(db, 'platform');
    await audit(db, auth.user.id, 'mfa.setup_started', `user:${auth.user.id}`, null, clientIp(request));
    // The secret is returned exactly once, to the session that just proved
    // itself. It is stored encrypted and never handed out again.
    return {
      secret,
      uri: totpUri(secret, auth.user.email, platform.serverName),
    };
  });

  app.post('/v1/account/mfa/totp/confirm', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`mfa-confirm:${auth.user.id}`, 10);
    const body = z.object({ code: mfaCodeSchema }).parse(request.body);
    const recoveryCodes = await confirmTotpEnrollment(db, config, auth.user.id, body.code);
    await audit(db, auth.user.id, 'mfa.enabled', `user:${auth.user.id}`, null, clientIp(request));
    return { enabled: true, recoveryCodes };
  });

  app.post('/v1/account/mfa/recovery-codes', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`mfa-recovery:${auth.user.id}`, 5);
    // Fresh recovery codes are a working second factor, so handing them out
    // on the password alone would let a password be turned into full access.
    await requireReauth(context, request, auth.user.id, auth.user.password_hash, { requireMfa: true });
    if (!(await isMfaEnabled(db, auth.user.id))) {
      throw new ApiError(400, 'mfa_not_enabled', 'Two-factor authentication is not enabled');
    }
    const recoveryCodes = await regenerateRecoveryCodes(db, config, auth.user.id);
    await audit(db, auth.user.id, 'mfa.recovery_codes_replaced', `user:${auth.user.id}`, null, clientIp(request));
    return { recoveryCodes };
  });

  app.delete('/v1/account/mfa', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`mfa-disable:${auth.user.id}`, 5);
    await requireReauth(context, request, auth.user.id, auth.user.password_hash, { requireMfa: true });
    await disableMfa(db, auth.user.id);
    await audit(db, auth.user.id, 'mfa.disabled', `user:${auth.user.id}`, null, clientIp(request));
    return reply.code(204).send();
  });

  app.get('/v1/account/activity', async (request) => {
    const auth = await requireAuth(db, config, request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    const rows = await db.prepare(
      `SELECT id, action, target, detail_json, ip, created_at
       FROM audit_log WHERE actor_user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all<{
      id: string;
      action: string;
      target: string | null;
      detail_json: string | null;
      ip: string | null;
      created_at: string;
    }>(auth.user.id, query.limit);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        target: row.target,
        detail: parseDetail(row.detail_json),
        ip: row.ip,
        createdAt: row.created_at,
      })),
    };
  });

  /**
   * Everything this server holds about the account, for GDPR-style export.
   *
   * Encrypted vault records are included verbatim. They are useless without
   * the account's sync passphrase, which this server has never seen, so this
   * is a copy of the ciphertext rather than a copy of the data.
   */
  app.get('/v1/account/export', async (request) => {
    const auth = await requireAuth(db, config, request);
    const vaults = await listAccessibleVaults(db, auth.user.id);
    const devices = await db.prepare('SELECT * FROM devices WHERE user_id = ?')
      .all<DeviceRow>(auth.user.id);
    const items = await db.prepare(
      `SELECT s.* FROM sync_items s
       JOIN vault_members vm ON vm.vault_id = s.vault_id
       WHERE vm.user_id = ?`,
    ).all(auth.user.id);

    return {
      exportedAt: nowIso(),
      server: (await readSetting(db, 'platform')).serverName,
      note: 'Sync records are client-encrypted. This server cannot decrypt them and neither can this export alone.',
      user: publicUser(auth.user),
      vaults: vaults.map(publicVault),
      devices: devices.map(publicDevice),
      encryptedItems: items,
    };
  });

  app.delete('/v1/account', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await requireReauth(context, request, auth.user.id, auth.user.password_hash, { requireMfa: true });

    // An administrator who is the last one left would lock everybody out of
    // settings, invitations and user management with no way back in.
    if (auth.user.role === 'admin') {
      const admins = await db.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0",
      ).get<{ count: number }>();
      if (Number(admins?.count ?? 0) <= 1) {
        throw new ApiError(
          409,
          'last_admin',
          'Promote another administrator before deleting this account',
        );
      }
    }

    await assertOwnsNoTeams(db, auth.user.id);

    await audit(db, auth.user.id, 'account.delete', `user:${auth.user.id}`, {
      email: auth.user.email,
    }, clientIp(request));
    // Cascades remove devices, sessions, personal vaults, memberships and
    // their encrypted records. The audit line above survives with a null actor.
    await deleteAccount(db, auth.user.id);
    return reply.code(204).send();
  });

  app.get('/v1/devices', async (request) => {
    const auth = await requireAuth(db, config, request);
    const devices = await db.prepare(
      `SELECT * FROM devices WHERE user_id = ? AND ${LIVE_DEVICE_SQL}
       ORDER BY COALESCE(last_seen_at, created_at) DESC`,
    ).all<DeviceRow>(auth.user.id, nowIso());
    return {
      devices: devices.map((device) => ({
        ...publicDevice(device),
        current: device.id === auth.deviceId,
      })),
    };
  });

  app.patch('/v1/devices/:id', async (request) => {
    const auth = await requireAuth(db, config, request);
    const { id } = z.object({ id: z.string().min(1).max(160) }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    const changed = await db.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_id = ?')
      .run(body.name, id, auth.user.id);
    if (changed.changes !== 1) throw new ApiError(404, 'device_not_found', 'Device not found');
    return { renamed: true };
  });

  app.delete('/v1/devices/:id', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    const { id } = z.object({ id: z.string().min(1).max(160) }).parse(request.params);
    const device = await db.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
      .get(id, auth.user.id);
    if (!device) throw new ApiError(404, 'device_not_found', 'Device not found');
    await db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    await audit(db, auth.user.id, 'device.revoke', `device:${id}`, null, clientIp(request));
    return reply.code(204).send();
  });

  app.delete('/v1/devices', async (request) => {
    const auth = await requireAuth(db, config, request);
    // The device making the request is kept, so signing every other device out
    // does not also sign the person out of the page they are looking at.
    await db.prepare('DELETE FROM devices WHERE user_id = ? AND id <> ?')
      .run(auth.user.id, auth.deviceId);
    await revokeAllSessions(db, auth.user.id, auth.deviceId);
    await audit(db, auth.user.id, 'device.revoke_others', `user:${auth.user.id}`, null, clientIp(request));
    return { revoked: true };
  });
}

export async function accountBundle(context: RouteContext, userId: string) {
  const { db } = context;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?')
    .get<Parameters<typeof publicUser>[0]>(userId);
  if (!user) throw new ApiError(404, 'user_not_found', 'Account not found');

  const platform = await readSetting(db, 'platform');
  const vaults = await listAccessibleVaults(db, userId);
  const canSync = !emailVerificationRequired(platform) || Boolean(user.email_verified);

  return {
    user: publicUser(user),
    // Shaped for the Ravelon clients, which read `entitlements.canSync` to
    // decide whether to offer sync at all. Self-hosted has no paid tier, so
    // the only gate is whether this deployment requires a confirmed address.
    entitlements: {
      canSync,
      maxDevices: null,
      features: canSync
        ? ['localVault', 'ssh', 'sftp', 'snippets', 'sync', 'crossDeviceVault', 'devicePairing', 'teams']
        : ['localVault', 'ssh', 'sftp', 'snippets'],
    },
    deployment: {
      kind: 'selfHosted',
      serverName: platform.serverName,
      version: context.config.version,
    },
    vaults: vaults.map(publicVault),
    mfaEnabled: await isMfaEnabled(db, userId),
  };
}

/**
 * Re-checks the password, and the second factor when one is enrolled.
 *
 * Used before anything that would let an attacker who found an unlocked
 * session take the account over: turning MFA off, replacing recovery codes,
 * deleting the account.
 */
async function requireReauth(
  context: RouteContext,
  request: Parameters<typeof clientIp>[0],
  userId: string,
  passwordHash: string,
  options: { requireMfa?: boolean } = {},
): Promise<void> {
  const body = reauthSchema.safeParse(request.body ?? {});
  if (!body.success) {
    throw new ApiError(400, 'reauthentication_required', 'Confirm your password to continue');
  }
  await verifyReauth(context, userId, passwordHash, body.data, {
    requireMfa: options.requireMfa,
    ip: clientIp(request),
  });
}

function publicDevice(device: DeviceRow) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    lastSeenAt: device.last_seen_at,
    createdAt: device.created_at,
    mfaVerified: Boolean(device.mfa_verified_at),
  };
}

function parseDetail(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
