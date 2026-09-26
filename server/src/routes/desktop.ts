import { randomInt } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { newId, nowIso } from '../config.js';
import { lockSection } from '../db/database.js';
import { issueSession, requireAuth } from '../auth/sessions.js';
import { isMfaEnabled } from '../auth/mfa.js';
import { verifyReauth } from '../auth/reauth.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { encodedBytes, vaultCursor } from '../lib/sync.js';
import {
  ensurePersonalVault,
  requireVaultAccess,
  vaultRoleCanWrite,
  vaultStorageBytes,
} from '../lib/vaults.js';
import { accountBundle } from './account.js';
import {
  assertCanSync,
  assertNotInMaintenance,
  clientIp,
  deviceNameSchema,
  mfaCodeSchema,
  platformSchema,
  publicOrigin,
  type RouteContext,
} from './context.js';

const DESKTOP_AUTH_TTL_MS = 10 * 60 * 1000;
const DESKTOP_VAULT_BODY_LIMIT_BYTES = 24 * 1024 * 1024;
/**
 * How long `/v1/desktop/vault/watch` holds a request open.
 *
 * Well under a minute, so a reverse proxy's default idle timeout does not cut
 * the connection first, and under the iOS client's 35 second request timeout,
 * which otherwise turned every quiet poll into a network error.
 */
export const VAULT_WATCH_TIMEOUT_MS = 25 * 1000;

/** Long-polls one account may hold open at once. */
const MAX_WATCHES_PER_USER = 16;

export function registerDesktopRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, limiter, syncEvents } = context;
  const heldWatches = new Map<string, number>();

  /**
   * Starts browser-approved pairing.
   *
   * A desktop or mobile client with no keyboard-friendly sign-in opens the
   * returned URL, the person approves it in a session that is already signed
   * in, and the client exchanges its poll token for a session of its own. The
   * password never passes through the client being paired.
   */
  app.post('/v1/desktop-auth/start', async (request) => {
    limiter.hit(`pair-start:${clientIp(request)}`, config.rateLimit.authPerIpPerMin);
    await db.prepare('DELETE FROM desktop_auth_requests WHERE expires_at <= ? OR consumed_at IS NOT NULL')
      .run(nowIso());

    const body = z.object({
      deviceName: deviceNameSchema,
      platform: platformSchema.default('desktop'),
    }).parse(request.body);

    const id = newId();
    const pollToken = randomToken('dpt');
    // A short code the person can read off the client and compare in the
    // browser, so approving the wrong pending request is obvious.
    const userCode = `${randomDigits(3)}-${randomDigits(3)}`;
    const expiresAt = new Date(Date.now() + DESKTOP_AUTH_TTL_MS).toISOString();

    await db.prepare(
      `INSERT INTO desktop_auth_requests
        (id, poll_token_hash, user_id, device_name, platform, status, user_code, mfa_verified,
         expires_at, created_at)
       VALUES (?, ?, NULL, ?, ?, 'pending', ?, 0, ?, ?)`,
    ).run(id, sha256(pollToken), body.deviceName, body.platform, userCode, expiresAt, nowIso());

    return {
      requestId: id,
      pollToken,
      userCode,
      verificationUrl: `${publicOrigin(config, request)}/link-device?request=${encodeURIComponent(id)}`,
      expiresAt,
      intervalMs: 1500,
    };
  });

  app.get('/v1/desktop-auth/request/:requestId', async (request) => {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const row = await db.prepare(
      'SELECT id, device_name, platform, status, user_code, expires_at FROM desktop_auth_requests WHERE id = ?',
    ).get<{
      id: string;
      device_name: string;
      platform: string;
      status: string;
      user_code: string;
      expires_at: string;
    }>(requestId);
    if (!row) throw new ApiError(404, 'pairing_not_found', 'This pairing request was not found');
    const expired = Date.parse(row.expires_at) <= Date.now();
    return {
      requestId: row.id,
      deviceName: row.device_name,
      platform: row.platform,
      userCode: row.user_code,
      status: expired ? 'expired' : row.status,
      expiresAt: row.expires_at,
    };
  });

  app.post('/v1/desktop-auth/approve', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`pair-approve:${auth.user.id}`, config.rateLimit.authPerIpPerMin);
    await assertNotInMaintenance(context);
    const body = z.object({
      requestId: z.string().uuid(),
      password: z.string().min(1).max(512),
      mfaCode: mfaCodeSchema.optional(),
    }).parse(request.body);

    // Approving a pairing hands out a full session on a device that has not
    // authenticated at all, so the password, and the second factor where one
    // is enrolled, are checked again even though the caller holds a token.
    // Guesses count against the same per-account lockout as every other
    // sensitive change, so a stolen session cannot spread them across routes.
    await verifyReauth(context, auth.user.id, auth.user.password_hash, {
      password: body.password,
      mfaCode: body.mfaCode,
    }, { requireMfa: true, ip: clientIp(request) });
    const mfaVerified = await isMfaEnabled(db, auth.user.id);

    const claimed = await db.prepare(
      `UPDATE desktop_auth_requests
       SET user_id = ?, status = 'approved', approved_at = ?, mfa_verified = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    ).run(auth.user.id, nowIso(), mfaVerified ? 1 : 0, body.requestId, nowIso());
    if (claimed.changes !== 1) {
      throw new ApiError(409, 'pairing_unavailable', 'This pairing request expired or was already used');
    }

    await audit(db, auth.user.id, 'device.pair_approved', `pairing:${body.requestId}`, null, clientIp(request));
    return { approved: true, email: auth.user.email };
  });

  app.post('/v1/desktop-auth/exchange', async (request, reply) => {
    const body = z.object({
      requestId: z.string().uuid(),
      pollToken: z.string().min(20).max(400),
    }).parse(request.body);

    const row = await db.prepare(
      'SELECT * FROM desktop_auth_requests WHERE id = ? AND poll_token_hash = ?',
    ).get<{
      id: string;
      user_id: string | null;
      device_name: string;
      platform: string;
      status: string;
      mfa_verified: number;
      expires_at: string;
      consumed_at: string | null;
    }>(body.requestId, sha256(body.pollToken));
    if (!row) throw new ApiError(401, 'pairing_invalid', 'This pairing request is invalid');
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new ApiError(410, 'pairing_expired', 'This pairing request expired');
    }
    if (row.status === 'pending') return reply.code(202).send({ status: 'pending' });
    if (row.status !== 'approved' || !row.user_id || row.consumed_at) {
      throw new ApiError(409, 'pairing_used', 'This pairing request was already used');
    }

    const session = await db.transaction(async () => {
      // Claiming and issuing inside one transaction is what stops two clients
      // polling the same request from both getting a session.
      const claimed = await db.prepare(
        `UPDATE desktop_auth_requests SET status = 'consumed', consumed_at = ?
         WHERE id = ? AND status = 'approved' AND consumed_at IS NULL AND expires_at > ?`,
      ).run(nowIso(), body.requestId, nowIso());
      if (claimed.changes !== 1) {
        throw new ApiError(409, 'pairing_used', 'This pairing request was already used');
      }
      return await issueSession(db, config, row.user_id!, row.device_name, row.platform, {
        mfaVerified: Boolean(row.mfa_verified),
        ip: clientIp(request),
      });
    })();

    const bundle = await accountBundle(context, row.user_id);
    await audit(db, row.user_id, 'device.paired', `device:${session.deviceId}`, {
      deviceName: row.device_name,
      platform: row.platform,
    }, clientIp(request));

    return {
      ...session,
      status: 'complete',
      // The same user shape as `/v1/account/me`, so a client signed in through
      // the browser has the display name without a second request.
      user: bundle.user,
      entitlements: bundle.entitlements,
      vaults: bundle.vaults,
    };
  });

  /** The compact account view older desktop builds read after signing in. */
  app.get('/v1/desktop/account', async (request) => {
    const auth = await requireAuth(db, config, request);
    const bundle = await accountBundle(context, auth.user.id);
    return {
      email: bundle.user.email,
      pro: bundle.entitlements.canSync,
      deployment: 'selfHosted',
      vaults: bundle.vaults,
    };
  });

  /**
   * The legacy one-blob-per-vault snapshot.
   *
   * Current clients use the granular protocol and only touch this once, to
   * import an existing vault from a server they used before upgrading. It is
   * kept so an older client keeps working rather than silently losing sync.
   */
  app.get('/v1/desktop/vault', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    const query = z.object({ vaultId: z.string().min(1).max(160).optional() }).parse(request.query);
    const vault = query.vaultId
      ? await requireVaultAccess(db, auth.user.id, query.vaultId)
      : await ensurePersonalVault(db, auth.user.id);
    const snapshot = await db.prepare('SELECT version, blob FROM desktop_vault_blobs WHERE vault_id = ?')
      .get<{ version: number; blob: string }>(vault.id);
    if (!snapshot) {
      throw new ApiError(404, 'sync_snapshot_not_found', 'No encrypted snapshot exists for this vault yet');
    }
    return { vaultId: vault.id, version: Number(snapshot.version), blob: snapshot.blob };
  });

  app.get('/v1/desktop/vault/status', async (request) => {
    const auth = await requireAuth(db, config, request);
    const query = z.object({ vaultId: z.string().min(1).max(160).optional() }).parse(request.query);
    const vault = query.vaultId
      ? await requireVaultAccess(db, auth.user.id, query.vaultId)
      : await ensurePersonalVault(db, auth.user.id);
    return await snapshotStatus(context, vault.id);
  });

  /**
   * Long-poll companion to the sync-event socket.
   *
   * A client that cannot hold a WebSocket asks here and the request stays open
   * until the vault changes or the timeout passes. Answering immediately when
   * the client is already behind avoids a wasted round trip.
   */
  app.get('/v1/desktop/vault/watch', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`watch:${auth.user.id}`, config.rateLimit.syncPerUserPerMin);
    const query = z.object({
      vaultId: z.string().min(1).max(160).optional(),
      afterVersion: z.coerce.number().int().nonnegative().default(0),
      // Granular clients wait on the sync cursor rather than the legacy
      // snapshot version. Clients that sent their cursor as `afterVersion`
      // were answered at once, every time, because a granular vault's snapshot
      // version stays 0; they now send it here.
      afterCursor: z.coerce.number().int().nonnegative().optional(),
    }).parse(request.query);
    const vault = query.vaultId
      ? await requireVaultAccess(db, auth.user.id, query.vaultId)
      : await ensurePersonalVault(db, auth.user.id);

    const current = await snapshotStatus(context, vault.id);
    const behind = query.afterCursor !== undefined
      ? current.cursor !== String(query.afterCursor)
      : current.version !== query.afterVersion || current.exists !== (query.afterVersion > 0);
    if (behind) return current;
    // Each held request is an open connection. A client needs one per watched
    // vault; more than a handful means a runaway loop, which is answered
    // immediately instead of being allowed to pile up.
    const held = heldWatches.get(auth.user.id) ?? 0;
    if (held >= MAX_WATCHES_PER_USER) return current;
    heldWatches.set(auth.user.id, held + 1);
    try {
      await syncEvents.wait(vault.id, VAULT_WATCH_TIMEOUT_MS);
    } finally {
      const remaining = (heldWatches.get(auth.user.id) ?? 1) - 1;
      if (remaining > 0) heldWatches.set(auth.user.id, remaining);
      else heldWatches.delete(auth.user.id);
    }
    return await snapshotStatus(context, vault.id);
  });

  app.put('/v1/desktop/vault', { bodyLimit: DESKTOP_VAULT_BODY_LIMIT_BYTES }, async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    await assertNotInMaintenance(context);
    const body = z.object({
      vaultId: z.string().min(1).max(160).optional(),
      baseVersion: z.number().int().nonnegative(),
      blob: z.string().min(1).max(20 * 1024 * 1024),
    }).parse(request.body);

    const vault = body.vaultId
      ? await requireVaultAccess(db, auth.user.id, body.vaultId)
      : await ensurePersonalVault(db, auth.user.id);
    if (!vaultRoleCanWrite(vault.member_role)) {
      throw new ApiError(403, 'vault_write_required', 'This vault is read-only for your role');
    }

    const version = await db.transaction(async () => {
      // Read-then-write on both the version counter and the storage quota.
      await lockSection(db, 'vault_storage');
      const current = await db.prepare(
        'SELECT version, LENGTH(blob) AS blob_size FROM desktop_vault_blobs WHERE vault_id = ?',
      ).get<{ version: number; blob_size: number }>(vault.id);
      const currentVersion = Number(current?.version ?? 0);
      // Compare-and-swap on the whole snapshot: without it, two devices that
      // both uploaded would silently overwrite each other's entire vault.
      if (body.baseVersion !== currentVersion) {
        throw new ApiError(
          409,
          'sync_version_conflict',
          `This vault is at version ${currentVersion}. Download it before uploading again`,
        );
      }
      const added = encodedBytes(body.blob) - Number(current?.blob_size ?? 0);
      if (await vaultStorageBytes(db, vault.id) + Math.max(0, added) > config.limits.vaultStorageBytes) {
        throw new ApiError(
          413,
          'vault_storage_quota_reached',
          'This vault reached the encrypted storage limit for this server',
        );
      }
      const next = currentVersion + 1;
      await db.prepare(
        `INSERT INTO desktop_vault_blobs (vault_id, version, blob, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(vault_id) DO UPDATE SET
           version = excluded.version,
           blob = excluded.blob,
           updated_at = excluded.updated_at,
           updated_by_user_id = excluded.updated_by_user_id`,
      ).run(vault.id, next, body.blob, nowIso(), auth.user.id);
      return next;
    })();

    await audit(db, auth.user.id, 'sync.snapshot_upload', `vault:${vault.id}`, { version }, clientIp(request));
    syncEvents.publish({
      type: 'vaultChanged',
      vaultId: vault.id,
      cursor: String(await vaultCursor(db, vault.id)),
    });
    return { vaultId: vault.id, version };
  });
}

async function snapshotStatus(context: RouteContext, vaultId: string) {
  const row = await context.db.prepare(
    'SELECT version, updated_at FROM desktop_vault_blobs WHERE vault_id = ?',
  ).get<{ version: number; updated_at: string }>(vaultId);
  // `cursor` is the granular head, so one request tells a client both whether
  // a legacy snapshot exists and whether it has missed a granular change.
  const cursor = String(await vaultCursor(context.db, vaultId));
  return row
    ? { exists: true, version: Number(row.version), updatedAt: row.updated_at, vaultId, cursor }
    : { exists: false, version: 0, updatedAt: null, vaultId, cursor };
}

function randomDigits(count: number): string {
  return Array.from({ length: count }, () => randomInt(0, 10)).join('');
}
