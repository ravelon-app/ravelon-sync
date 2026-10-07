import type { FastifyRequest } from 'fastify';

import { type Config, newId, nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256, signAccessToken, verifyAccessToken } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { DeviceRow, RefreshTokenRow, UserRow } from '../lib/rows.js';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
  userId: string;
}

export interface AuthContext {
  user: UserRow;
  deviceId: string;
}

export async function getUserById(db: AppDatabase, id: string): Promise<UserRow | undefined> {
  return await db.prepare('SELECT * FROM users WHERE id = ?').get<UserRow>(id);
}

export async function getUserByEmail(db: AppDatabase, email: string): Promise<UserRow | undefined> {
  return await db.prepare('SELECT * FROM users WHERE email = ?').get<UserRow>(email.trim().toLowerCase());
}

/**
 * Registers a device and hands out one access token plus one refresh token.
 *
 * Every sign-in creates a device row, so an account holder can see and revoke
 * each place they are signed in from.
 */
export async function issueSession(
  db: AppDatabase,
  config: Config,
  userId: string,
  deviceName: string,
  platform: string,
  options: { mfaVerified?: boolean; ip?: string | null } = {},
): Promise<IssuedSession> {
  const user = await getUserById(db, userId);
  if (!user) throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
  if (user.disabled) throw new ApiError(403, 'account_disabled', 'This account is disabled');

  const deviceId = newId();
  const refreshToken = randomToken('rft');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000).toISOString();

  await db.transaction(async () => {
    await db
      .prepare(
        `INSERT INTO devices (id, user_id, name, platform, last_seen_at, last_ip, mfa_verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deviceId,
        userId,
        deviceName.trim() || 'Ravelon',
        platform.trim() || 'web',
        now,
        options.ip ?? null,
        options.mfaVerified ? now : null,
        now,
      );
    await db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), userId, deviceId, sha256(refreshToken), expiresAt, now);
    await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId);
  })();

  return {
    accessToken: signAccessToken(
      config.jwtSecret,
      { sub: user.id, email: user.email, role: user.role, deviceId },
      config.accessTokenTtlSec,
    ),
    refreshToken,
    expiresIn: config.accessTokenTtlSec,
    deviceId,
    userId,
  };
}

/**
 * Rotates a refresh token.
 *
 * Presenting a token that was already rotated means either a stolen copy or a
 * client replaying an old one. Both are treated as compromise: every session
 * on that device is revoked, and the caller has to sign in again.
 */
export async function rotateRefreshToken(
  db: AppDatabase,
  config: Config,
  refreshToken: string,
  options: { ip?: string | null } = {},
): Promise<IssuedSession> {
  const tokenHash = sha256(refreshToken);
  const outcome = await db.transaction(async () => {
    const row = await db
      .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
      .get<RefreshTokenRow>(tokenHash);
    if (!row || Date.parse(row.expires_at) <= Date.now()) return { status: 'invalid' as const };
    if (row.revoked_at) {
      // Only a token that was rotated (replaced_by set) and comes back is a
      // replay. One revoked by signing out, a password change or a disabled
      // account is simply dead; calling that theft filled the audit log with
      // false alarms whenever an operator locked an account.
      if (!row.replaced_by) return { status: 'invalid' as const };
      return { status: 'reuse' as const, userId: row.user_id, deviceId: row.device_id };
    }
    const user = await getUserById(db, row.user_id);
    if (!user) return { status: 'invalid' as const };
    if (user.disabled) return { status: 'disabled' as const };

    const newToken = randomToken('rft');
    const newRowId = newId();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000).toISOString();
    // Claiming the row conditionally is what makes two concurrent refreshes
    // resolve to exactly one winner; the loser falls through to reuse.
    const claimed = await db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ?
       WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(now, newRowId, row.id, now);
    if (claimed.changes !== 1) {
      return { status: 'reuse' as const, userId: row.user_id, deviceId: row.device_id };
    }
    await db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newRowId, row.user_id, row.device_id, sha256(newToken), expiresAt, now);
    await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.device_id);
    await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.user_id);
    return { status: 'ok' as const, row, user, newToken };
  })();

  if (outcome.status === 'reuse') {
    await revokeDeviceSessions(db, outcome.deviceId);
    // A replayed refresh token is the one signal of a stolen session this
    // server gets, so the operator and the account holder must be able to
    // see it. The token itself is never recorded.
    await audit(
      db,
      outcome.userId,
      'auth.refresh_reuse_detected',
      `device:${outcome.deviceId}`,
      null,
      options.ip ?? null,
    );
    throw new ApiError(401, 'refresh_token_reused', 'Session was revoked. Sign in again');
  }
  if (outcome.status === 'disabled') {
    throw new ApiError(403, 'account_disabled', 'This account is disabled');
  }
  if (outcome.status === 'invalid') {
    throw new ApiError(401, 'invalid_refresh_token', 'Refresh token is invalid or expired');
  }

  return {
    accessToken: signAccessToken(
      config.jwtSecret,
      {
        sub: outcome.user.id,
        email: outcome.user.email,
        role: outcome.user.role,
        deviceId: outcome.row.device_id,
      },
      config.accessTokenTtlSec,
    ),
    refreshToken: outcome.newToken,
    expiresIn: config.accessTokenTtlSec,
    deviceId: outcome.row.device_id,
    userId: outcome.user.id,
  };
}

/**
 * A device counts as signed in while it holds a refresh token that is neither
 * revoked nor expired. Signing out, a password change or an admin action only
 * revoke tokens, so without this the device list kept showing them as signed
 * in. Bind the current time as the parameter.
 */
export const LIVE_DEVICE_SQL = `EXISTS (
  SELECT 1 FROM refresh_tokens r
  WHERE r.device_id = devices.id AND r.revoked_at IS NULL AND r.expires_at > ?
)`;

export async function revokeDeviceSessions(db: AppDatabase, deviceId: string): Promise<void> {
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .run(nowIso(), deviceId);
}

export async function revokeAllSessions(
  db: AppDatabase,
  userId: string,
  exceptDeviceId?: string,
): Promise<void> {
  if (exceptDeviceId) {
    await db
      .prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id <> ? AND revoked_at IS NULL',
      )
      .run(nowIso(), userId, exceptDeviceId);
    return;
  }
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), userId);
}

export async function revokeSessionByRefreshToken(db: AppDatabase, refreshToken: string): Promise<void> {
  const row = await db
    .prepare('SELECT device_id FROM refresh_tokens WHERE token_hash = ?')
    .get<{ device_id: string }>(sha256(refreshToken));
  if (row) await revokeDeviceSessions(db, row.device_id);
}

/**
 * Resolves the bearer token on a request into an account and device.
 *
 * The signature alone is not enough. A token stays valid for its full lifetime
 * even after the device was revoked or the account disabled, so both are
 * re-checked against the database on every request.
 */
export async function requireAuth(
  db: AppDatabase,
  config: Config,
  request: FastifyRequest,
): Promise<AuthContext> {
  const header = request.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized', 'Authentication required');

  const claims = verifyAccessToken(config.jwtSecret, token);
  if (!claims) throw new ApiError(401, 'invalid_token', 'Access token is invalid or expired');

  const user = await getUserById(db, claims.sub);
  if (!user) throw new ApiError(401, 'invalid_token', 'Access token is invalid or expired');
  if (user.disabled) throw new ApiError(403, 'account_disabled', 'This account is disabled');

  const device = await db
    .prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?')
    .get<DeviceRow>(claims.deviceId, user.id);
  if (!device) throw new ApiError(401, 'device_revoked', 'This device was signed out');

  const live = await db
    .prepare(
      'SELECT id FROM refresh_tokens WHERE device_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
    )
    .get(device.id, nowIso());
  if (!live) throw new ApiError(401, 'device_revoked', 'This device was signed out');

  return { user, deviceId: device.id };
}

export async function requireAdmin(
  db: AppDatabase,
  config: Config,
  request: FastifyRequest,
): Promise<AuthContext> {
  const auth = await requireAuth(db, config, request);
  if (auth.user.role !== 'admin') {
    throw new ApiError(403, 'admin_required', 'Administrator access is required');
  }
  return auth;
}

/** Best-effort last-seen bookkeeping; never fails a request. */
export async function touchDevice(db: AppDatabase, deviceId: string, ip: string | null): Promise<void> {
  try {
    await db
      .prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?')
      .run(nowIso(), ip, deviceId);
  } catch {
    // Losing a timestamp is not worth failing the caller's request over.
  }
}
