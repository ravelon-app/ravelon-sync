import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { nowIso } from '../config.js';
import { lockSection } from '../db/database.js';
import { requireAuth } from '../auth/sessions.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { ExistingSyncItemRow, SyncItemRow } from '../lib/rows.js';
import { readSetting } from '../lib/settings.js';
import { MAX_SOCKETS_PER_USER } from '../lib/sync-events.js';
import {
  compareRevision,
  encodedBytes,
  insertSyncVersion,
  isUnchangedSyncItem,
  nextCursor,
  publicSyncItem,
  SYNC_PULL_PAGE_BYTES,
  SYNC_PULL_PAGE_SIZE,
  SYNC_PUSH_MAX_ITEMS,
  type SyncItemInput,
  type SyncPushResult,
  syncItemSchema,
  validateSyncItem,
  vaultCursor,
} from '../lib/sync.js';
import {
  ensureVaultForClientId,
  getVaultAccess,
  requireVaultAccess,
  vaultRoleCanWrite,
  vaultStorageBytes,
} from '../lib/vaults.js';
import { assertCanSync, assertNotInMaintenance, clientIp, type RouteContext } from './context.js';

/** 64 MiB: a first sync of a large vault arrives as one push. */
export const SYNC_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

export function registerSyncRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, limiter, syncEvents } = context;

  /**
   * Accepts a batch of encrypted records.
   *
   * Each item is answered independently, because one stale record must not
   * fail the other 499. The four outcomes are:
   *
   * - `stored`    written, `revision` is its new cursor
   * - `unchanged` already identical, nothing written
   * - `stale`     an older last-writer-wins push; the client should pull
   * - `conflict`  `baseRevision` no longer matches; `current` carries the
   *               server's version so the client can merge and retry
   *
   * The server cannot merge anything itself: it never has the keys.
   */
  app.post('/v1/sync/push', { bodyLimit: SYNC_BODY_LIMIT_BYTES }, async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`sync:${auth.user.id}`, config.rateLimit.syncPerUserPerMin);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    await assertNotInMaintenance(context);

    const body = z
      .object({
        vaultId: z.string().min(1).max(160),
        items: z.array(syncItemSchema).max(SYNC_PUSH_MAX_ITEMS),
      })
      .parse(request.body);

    const vault = await ensureVaultForClientId(db, config, auth.user.id, body.vaultId);
    if (!vaultRoleCanWrite(vault.member_role)) {
      throw new ApiError(403, 'vault_write_required', 'This vault is read-only for your role');
    }
    const platform = await readSetting(db, 'platform');

    const results: SyncPushResult[] = [];
    await db.transaction(async (items: SyncItemInput[]) => {
      // The quota is read here and enforced against writes below, so two
      // concurrent pushes to one vault must not both pass the check.
      await lockSection(db, 'vault_storage');
      let storageBytes = await vaultStorageBytes(db, vault.id);

      for (const item of items) {
        validateSyncItem(item, body.vaultId);

        const existing = await db
          .prepare(
            `SELECT vault_id, item_id, item_type, ciphertext, nonce, schema_version,
                  client_revision, updated_at, deleted_at, restored_at, cursor, stored_at,
                  LENGTH(ciphertext) AS ciphertext_size, LENGTH(nonce) AS nonce_size
           FROM sync_items WHERE vault_id = ? AND item_id = ?`,
          )
          .get<ExistingSyncItemRow>(vault.id, item.id);

        // Compare-and-swap path: the client told us what it based this edit
        // on, so a mismatch is a real conflict and it gets our version back.
        if (existing && item.baseRevision !== undefined && item.baseRevision !== Number(existing.cursor)) {
          results.push({
            id: item.id,
            status: 'conflict',
            revision: Number(existing.cursor),
            current: publicSyncItem(existing),
          });
          continue;
        }
        // No row but a non-zero base: the client last saw a copy this server
        // no longer has, for example after a restore from an older backup.
        // There is no newer version to protect, and a conflict without
        // `current` is one no client can resolve, so it is stored instead.

        // Last-writer-wins path, for clients that send no baseRevision.
        if (
          existing &&
          item.baseRevision === undefined &&
          compareRevision(
            item.clientRevision,
            item.updatedAt,
            Number(existing.client_revision),
            existing.updated_at,
          ) < 0
        ) {
          results.push({ id: item.id, status: 'stale', revision: Number(existing.cursor) });
          continue;
        }

        if (existing && isUnchangedSyncItem(existing, item)) {
          results.push({ id: item.id, status: 'unchanged', revision: Number(existing.cursor) });
          continue;
        }

        // A version row is kept alongside the item, so the quota counts the
        // new bytes twice and only reclaims what this write replaces.
        const itemBytes = encodedBytes(item.ciphertext, item.nonce);
        const replacedBytes = existing ? Number(existing.ciphertext_size) + Number(existing.nonce_size) : 0;
        const addedBytes = itemBytes * 2 - replacedBytes;
        if (storageBytes + Math.max(0, addedBytes) > config.limits.vaultStorageBytes) {
          throw new ApiError(
            413,
            'vault_storage_quota_reached',
            'This vault reached the encrypted storage limit for this server',
          );
        }
        storageBytes += addedBytes;

        const cursor = await nextCursor(db);
        const storedAt = nowIso();
        await db
          .prepare(
            `INSERT INTO sync_items
            (vault_id, item_id, item_type, ciphertext, nonce, schema_version,
             client_revision, updated_at, deleted_at, restored_at, cursor, stored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(vault_id, item_id) DO UPDATE SET
             item_type = excluded.item_type,
             ciphertext = excluded.ciphertext,
             nonce = excluded.nonce,
             schema_version = excluded.schema_version,
             client_revision = excluded.client_revision,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             restored_at = NULL,
             cursor = excluded.cursor,
             stored_at = excluded.stored_at`,
          )
          .run(
            vault.id,
            item.id,
            item.itemType,
            item.ciphertext,
            item.nonce,
            item.schemaVersion,
            item.clientRevision,
            item.updatedAt,
            item.deletedAt ?? null,
            cursor,
            storedAt,
          );

        await insertSyncVersion(
          db,
          {
            vaultId: vault.id,
            itemId: item.id,
            itemType: item.itemType,
            ciphertext: item.ciphertext,
            nonce: item.nonce,
            schemaVersion: item.schemaVersion,
            clientRevision: item.clientRevision,
            updatedAt: item.updatedAt,
            deletedAt: item.deletedAt ?? null,
            restoredAt: null,
            versionCursor: cursor,
            storedAt,
            actorUserId: auth.user.id,
            deviceId: auth.deviceId,
            reason: item.deletedAt ? 'sync_delete' : 'sync_push',
          },
          platform.itemVersionsKept,
        );

        results.push({ id: item.id, status: 'stored', revision: cursor });
      }
    })(body.items);

    const cursor = String(await vaultCursor(db, vault.id));
    const stored = results.filter((result) => result.status === 'stored').length;
    if (stored > 0) {
      await db.prepare('UPDATE vaults SET updated_at = ? WHERE id = ?').run(nowIso(), vault.id);
      // Deliberately no per-item audit line: it would grow without bound and
      // record nothing an operator can act on. Counts are enough.
      await audit(
        db,
        auth.user.id,
        'sync.push',
        `vault:${vault.id}`,
        {
          stored,
          total: results.length,
        },
        clientIp(request),
      );
      syncEvents.publish({ type: 'vaultChanged', vaultId: vault.id, cursor });
    }
    return { cursor, results };
  });

  /**
   * Returns everything after `cursor`, oldest first.
   *
   * Deletes come back as tombstones rather than gaps, so a client that was
   * offline learns about them instead of resurrecting the record.
   */
  app.get('/v1/sync/pull', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`sync:${auth.user.id}`, config.rateLimit.syncPerUserPerMin);
    await assertCanSync(context, Boolean(auth.user.email_verified));

    const query = z
      .object({
        vaultId: z.string().min(1).max(160),
        cursor: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(request.query);

    const vault = await requireVaultAccess(db, auth.user.id, query.vaultId);

    // The head is read before the rows, and rows past it are left for the next
    // pull. Every writer allocates cursors under one lock held until commit,
    // so everything at or below a committed head is already visible. Reading
    // the head afterwards instead could report a cursor for a record that
    // committed between the two statements and was never sent.
    const head = await vaultCursor(db, vault.id);
    const window = await db
      .prepare(
        `SELECT cursor, LENGTH(ciphertext) + LENGTH(nonce) AS size FROM sync_items
       WHERE vault_id = ? AND cursor > ? AND cursor <= ?
       ORDER BY cursor ASC
       LIMIT ?`,
      )
      .all<{ cursor: number; size: number }>(vault.id, query.cursor, head, SYNC_PULL_PAGE_SIZE + 1);

    let last = query.cursor;
    let bytes = 0;
    let taken = 0;
    for (const row of window.slice(0, SYNC_PULL_PAGE_SIZE)) {
      // At least one record per page, however large, or a single oversized
      // record would stall the client on an empty page forever.
      if (taken > 0 && bytes + Number(row.size) > SYNC_PULL_PAGE_BYTES) break;
      bytes += Number(row.size);
      taken += 1;
      last = Number(row.cursor);
    }
    const hasMore = taken < window.length;
    const page =
      taken === 0
        ? []
        : await db
            .prepare(
              `SELECT * FROM sync_items
       WHERE vault_id = ? AND cursor > ? AND cursor <= ?
       ORDER BY cursor ASC`,
            )
            .all<SyncItemRow>(vault.id, query.cursor, last);

    // A partial page reports its last row so the next request continues from
    // there; a final page reports the head read above, which also carries the
    // client past cursors spent on other vaults. A head below the cursor the
    // client sent means the database was restored from an older backup, and
    // reporting it lets the client notice and pull from the start again.
    const cursor = String(hasMore ? last : head);

    return { cursor, hasMore, items: page.map(publicSyncItem) };
  });

  /**
   * Wakes clients when a vault changes.
   *
   * The message carries only the vault id and its cursor. No record data
   * crosses this socket, so a compromised connection reveals nothing beyond
   * the fact that something changed.
   */
  app.get('/v1/sync/events', { websocket: true }, (socket, request) => {
    void (async () => {
      const auth = await requireAuth(db, config, request);
      await assertCanSync(context, Boolean(auth.user.email_verified));
      const query = z.object({ vaultId: z.string().min(1).max(160) }).parse(request.query);
      const vault = await getVaultAccess(db, auth.user.id, query.vaultId);
      if (!vault) throw new ApiError(403, 'vault_not_accessible', 'Vault not found or not accessible');
      if (syncEvents.socketsFor(auth.user.id) >= MAX_SOCKETS_PER_USER) {
        // 1013 is "try again later": clients reconnect quietly instead of
        // reporting a policy failure.
        socket.close(1013, 'too_many_connections');
        return;
      }

      const userId = auth.user.id;
      const deviceId = auth.deviceId;
      syncEvents.subscribe(vault.id, socket, {
        userId,
        // The access token is deliberately not re-verified here: it expires
        // every few minutes and clients reconnect on their own schedule. What
        // is re-checked is what an operator or owner can take away.
        revalidate: async () => {
          const user = await db
            .prepare('SELECT disabled FROM users WHERE id = ?')
            .get<{ disabled: number }>(userId);
          if (!user || user.disabled) return 'unauthorized';
          const live = await db
            .prepare(
              `SELECT rt.id FROM refresh_tokens rt
             JOIN devices d ON d.id = rt.device_id
             WHERE d.id = ? AND d.user_id = ? AND rt.revoked_at IS NULL AND rt.expires_at > ?
             LIMIT 1`,
            )
            .get(deviceId, userId, nowIso());
          if (!live) return 'unauthorized';
          if (!(await getVaultAccess(db, userId, vault.id))) return 'vault_not_accessible';
          return null;
        },
      });
      // An immediate first message lets a client that reconnected after a
      // restart notice a cursor it missed without waiting for the next change.
      socket.send(
        JSON.stringify({
          type: 'vaultChanged',
          vaultId: vault.id,
          cursor: String(await vaultCursor(db, vault.id)),
        }),
      );
    })().catch((error: unknown) => {
      socket.close(1008, socketCloseReason(error));
    });
  });

  /**
   * Wrapped vault keys, stored and returned verbatim for this account.
   *
   * This is how a second device joins a vault: it receives key material it can
   * unwrap with the account's own sync passphrase. The server holds the
   * envelope and can never open it.
   */
  app.put('/v1/vault/key-material', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    await assertNotInMaintenance(context);
    const body = z
      .object({
        vaultId: z.string().min(1).max(160),
        material: z.record(z.string(), z.unknown()),
        // "Create, never replace." Two first devices of one account can both find
        // no envelope and both mint a secret; without this the later PUT would
        // silently overwrite the earlier one and the two devices would encrypt
        // under different keys. With it, the second PUT is refused with 409 and
        // that device adopts the envelope that won.
        ifAbsent: z.boolean().optional(),
      })
      .parse(request.body);

    const vault = await requireVaultAccess(db, auth.user.id, body.vaultId);
    assertOpaqueKeyMaterial(body.material);

    const serialized = JSON.stringify(body.material);
    if (serialized.length > 256 * 1024) {
      throw new ApiError(413, 'key_material_too_large', 'Vault key material is too large');
    }
    if (body.ifAbsent) {
      const inserted = await db
        .prepare(
          `INSERT INTO vault_user_key_material (vault_id, user_id, material_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vault_id, user_id) DO NOTHING`,
        )
        .run(vault.id, auth.user.id, serialized, nowIso());
      if (inserted.changes === 0) {
        throw new ApiError(409, 'key_material_exists', 'Key material for this vault already exists');
      }
    } else {
      await db
        .prepare(
          `INSERT INTO vault_user_key_material (vault_id, user_id, material_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vault_id, user_id) DO UPDATE SET
           material_json = excluded.material_json,
           updated_at = excluded.updated_at`,
        )
        .run(vault.id, auth.user.id, serialized, nowIso());
    }
    await audit(db, auth.user.id, 'vault.key_material_updated', `vault:${vault.id}`, null, clientIp(request));
    return { stored: true };
  });

  app.get('/v1/vault/key-material', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    const query = z.object({ vaultId: z.string().min(1).max(160) }).parse(request.query);
    const vault = await requireVaultAccess(db, auth.user.id, query.vaultId);
    const row = await db
      .prepare(
        'SELECT material_json, updated_at FROM vault_user_key_material WHERE vault_id = ? AND user_id = ?',
      )
      .get<{ material_json: string; updated_at: string }>(vault.id, auth.user.id);
    if (!row) throw new ApiError(404, 'key_material_not_found', 'No key material stored for this vault');
    return {
      vaultId: vault.id,
      material: JSON.parse(row.material_json) as Record<string, unknown>,
      updatedAt: row.updated_at,
    };
  });
}

/**
 * The close reason a failed socket setup reports.
 *
 * Every authentication failure is reported as `unauthorized`, whatever the
 * precise cause, because that is the reason clients recognise as "refresh the
 * session and reconnect". A distinct `invalid_token` made the iOS client treat
 * an ordinary expired token as a permanent refusal.
 */
export function socketCloseReason(error: unknown): string {
  if (error instanceof ApiError) return error.status === 401 ? 'unauthorized' : error.code;
  if (error instanceof z.ZodError) return 'validation_failed';
  return 'sync_event_setup_failed';
}

/**
 * Field names that would mean a client uploaded an unwrapped key.
 *
 * Key material is supposed to be wrapped before it is sent. Refusing anything
 * that names a raw secret turns a client bug into a loud failure instead of a
 * silent leak of the one thing this design exists to protect.
 */
const RAW_KEY_MATERIAL_FIELDS = new Set([
  'masterpassword',
  'passphrase',
  'plaintextkey',
  'rawkey',
  'privatekey',
  'recoverykey',
  'dek',
  'kek',
  'secret',
  'password',
]);

function assertOpaqueKeyMaterial(material: unknown): void {
  if (containsRawSecret(material)) {
    throw new ApiError(
      400,
      'raw_vault_key_material',
      'Vault key material must contain only wrapped key material',
    );
  }
}

function containsRawSecret(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsRawSecret);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_KEY_MATERIAL_FIELDS.has(key.replace(/[-_]/g, '').toLowerCase())) return true;
    if (containsRawSecret(nested)) return true;
  }
  return false;
}
