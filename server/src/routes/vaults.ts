import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { newId, nowIso } from '../config.js';
import { lockSection } from '../db/database.js';
import { requireAuth } from '../auth/sessions.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { SyncItemRow, UserRow, VaultRole } from '../lib/rows.js';
import { readSetting } from '../lib/settings.js';
import { insertSyncVersion, nextCursor, publicSyncItem, vaultCursor } from '../lib/sync.js';
import {
  assertVaultCreationAvailable,
  ensureVaultMember,
  getVaultAccess,
  listAccessibleVaults,
  publicVault,
  requireTeamAdmin,
  requireVaultAccess,
  vaultRoleCanAdmin,
  vaultRoleCanWrite,
  vaultStorageBytes,
  VAULT_ROLES,
} from '../lib/vaults.js';
import {
  assertCanSync,
  assertNotInMaintenance,
  clientIp,
  idParam,
  type RouteContext,
  vaultNameSchema,
} from './context.js';

export function registerVaultRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, syncEvents } = context;

  app.get('/v1/vaults', async (request) => {
    const auth = await requireAuth(db, config, request);
    const vaults = await listAccessibleVaults(db, auth.user.id);
    return {
      vaults: await Promise.all(vaults.map(async (vault) => ({
        ...publicVault(vault),
        itemCount: await countItems(context, vault.id),
        storageBytes: await vaultStorageBytes(db, vault.id),
        cursor: String(await vaultCursor(db, vault.id)),
      }))),
    };
  });

  app.post('/v1/vaults', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    await assertNotInMaintenance(context);
    await assertVaultCreationAvailable(db, config, auth.user.id);

    const body = z.object({
      name: vaultNameSchema,
      kind: z.enum(['personal', 'team']).default('personal'),
      teamId: z.string().min(1).max(160).nullish(),
    }).parse(request.body);

    if (body.kind === 'team' && !body.teamId) {
      throw new ApiError(400, 'team_required', 'A team vault needs a team');
    }
    const team = body.kind === 'team'
      ? await requireTeamAdmin(db, auth.user.id, body.teamId!)
      : null;

    const vaultId = newId();
    const now = nowIso();
    await db.transaction(async () => {
      await db.prepare(
        `INSERT INTO vaults (id, user_id, name, kind, team_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(vaultId, auth.user.id, body.name, body.kind, team?.id ?? null, auth.user.id, now, now);

      if (team) {
        // Everyone already in the team gets the role their membership names,
        // so a new team vault is usable without a second round of invitations.
        const members = await db.prepare(
          'SELECT user_id, default_vault_role FROM team_members WHERE team_id = ?',
        ).all<{ user_id: string; default_vault_role: VaultRole }>(team.id);
        for (const member of members) {
          await ensureVaultMember(db, vaultId, member.user_id, member.default_vault_role);
        }
        await ensureVaultMember(db, vaultId, auth.user.id, 'owner');
      } else {
        await ensureVaultMember(db, vaultId, auth.user.id, 'owner');
      }
    })();

    await audit(db, auth.user.id, 'vault.create', `vault:${vaultId}`, {
      name: body.name,
      kind: body.kind,
      teamId: team?.id ?? null,
    }, clientIp(request));
    return reply.code(201).send(publicVault((await getVaultAccess(db, auth.user.id, vaultId))!));
  });

  app.patch('/v1/vaults/:id', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const vault = await requireVaultAccess(db, auth.user.id, idParam(request));
    if (!vaultRoleCanAdmin(vault.member_role)) {
      throw new ApiError(403, 'vault_admin_required', 'Vault administrator access is required');
    }
    const body = z.object({ name: vaultNameSchema }).parse(request.body);
    await db.prepare('UPDATE vaults SET name = ?, updated_at = ? WHERE id = ?')
      .run(body.name, nowIso(), vault.id);
    await audit(db, auth.user.id, 'vault.rename', `vault:${vault.id}`, { name: body.name }, clientIp(request));
    return publicVault((await getVaultAccess(db, auth.user.id, vault.id))!);
  });

  app.delete('/v1/vaults/:id', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const vault = await requireVaultAccess(db, auth.user.id, idParam(request));
    if (vault.member_role !== 'owner') {
      throw new ApiError(403, 'vault_owner_required', 'Only the vault owner can delete it');
    }
    // A team vault belongs to the team, not to whoever happens to own the row.
    if (vault.kind === 'team' && vault.team_id) {
      await requireTeamAdmin(db, auth.user.id, vault.team_id);
    }
    await audit(db, auth.user.id, 'vault.delete', `vault:${vault.id}`, {
      name: vault.name,
      items: await countItems(context, vault.id),
    }, clientIp(request));
    // Cascades take the encrypted records, versions, memberships and key
    // material with it. Nothing recoverable is left behind on purpose.
    await db.prepare('DELETE FROM vaults WHERE id = ?').run(vault.id);
    return reply.code(204).send();
  });

  app.get('/v1/vaults/:id/members', async (request) => {
    const auth = await requireAuth(db, config, request);
    const vault = await requireVaultAccess(db, auth.user.id, idParam(request));
    return { members: await listVaultMembers(context, vault.id) };
  });

  app.patch('/v1/vaults/:id/members/:userId', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const { id, userId } = z.object({
      id: z.string().min(1).max(160),
      userId: z.string().min(1).max(160),
    }).parse(request.params);
    const vault = await requireVaultAccess(db, auth.user.id, id);
    if (!vaultRoleCanAdmin(vault.member_role)) {
      throw new ApiError(403, 'vault_admin_required', 'Vault administrator access is required');
    }
    const body = z.object({ role: z.enum(VAULT_ROLES as unknown as [VaultRole, ...VaultRole[]]) })
      .parse(request.body);

    const target = await db.prepare('SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?')
      .get<{ role: VaultRole }>(vault.id, userId);
    if (!target) throw new ApiError(404, 'member_not_found', 'That account is not a member of this vault');
    // Only an owner may hand out or take away ownership; an admin must not be
    // able to promote themselves past the person who created the vault.
    if ((target.role === 'owner' || body.role === 'owner') && vault.member_role !== 'owner') {
      throw new ApiError(403, 'vault_owner_required', 'Only the vault owner can change ownership');
    }
    if (target.role === 'owner' && body.role !== 'owner' && userId === auth.user.id) {
      throw new ApiError(409, 'last_vault_owner', 'Give ownership to someone else first');
    }

    await ensureVaultMember(db, vault.id, userId, body.role);
    await audit(db, auth.user.id, 'vault.member_role', `vault:${vault.id}`, {
      userId,
      role: body.role,
    }, clientIp(request));
    return { members: await listVaultMembers(context, vault.id) };
  });

  app.delete('/v1/vaults/:id/members/:userId', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const { id, userId } = z.object({
      id: z.string().min(1).max(160),
      userId: z.string().min(1).max(160),
    }).parse(request.params);
    const vault = await requireVaultAccess(db, auth.user.id, id);
    // Leaving on your own needs no privilege; removing somebody else does.
    if (userId !== auth.user.id && !vaultRoleCanAdmin(vault.member_role)) {
      throw new ApiError(403, 'vault_admin_required', 'Vault administrator access is required');
    }
    const target = await db.prepare('SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?')
      .get<{ role: VaultRole }>(vault.id, userId);
    if (!target) throw new ApiError(404, 'member_not_found', 'That account is not a member of this vault');
    if (target.role === 'owner') {
      throw new ApiError(409, 'vault_owner_locked', 'Transfer ownership before removing the owner');
    }
    await db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vault.id, userId);
    await audit(db, auth.user.id, 'vault.member_remove', `vault:${vault.id}`, { userId }, clientIp(request));
    return reply.code(204).send();
  });

  /**
   * Metadata about stored versions.
   *
   * Ciphertext is deliberately not returned: this is the list you pick from,
   * and restoring is what puts a chosen version back into the sync stream.
   */
  app.get('/v1/vaults/:id/items/:itemId/versions', async (request) => {
    const auth = await requireAuth(db, config, request);
    const { id, itemId } = z.object({
      id: z.string().min(1).max(160),
      itemId: z.string().min(1).max(160),
    }).parse(request.params);
    const vault = await requireVaultAccess(db, auth.user.id, id);
    const rows = await db.prepare(
      `SELECT id, item_type, schema_version, client_revision, updated_at, deleted_at,
              restored_at, version_cursor, stored_at, device_id, reason
       FROM sync_item_versions
       WHERE vault_id = ? AND item_id = ?
       ORDER BY version_cursor DESC`,
    ).all<Record<string, unknown>>(vault.id, itemId);
    return {
      versions: rows.map((row) => ({
        id: row.id,
        itemType: row.item_type,
        schemaVersion: Number(row.schema_version),
        clientRevision: Number(row.client_revision),
        revision: Number(row.version_cursor),
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        restoredAt: row.restored_at,
        storedAt: row.stored_at,
        deviceId: row.device_id,
        reason: row.reason,
      })),
    };
  });

  /**
   * Puts an older version back.
   *
   * The stored blob is copied *forward* as a new revision rather than winding
   * the cursor back, so every other device pulls the restored state on its
   * next sync instead of silently disagreeing about history.
   */
  app.post('/v1/vaults/:id/items/:itemId/restore', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const { id, itemId } = z.object({
      id: z.string().min(1).max(160),
      itemId: z.string().min(1).max(160),
    }).parse(request.params);
    const body = z.object({ versionId: z.string().min(1).max(160) }).parse(request.body);

    const vault = await requireVaultAccess(db, auth.user.id, id);
    if (!vaultRoleCanWrite(vault.member_role)) {
      throw new ApiError(403, 'vault_write_required', 'This vault is read-only for your role');
    }
    const restored = await restoreSyncVersion(
      context,
      vault.id,
      itemId,
      body.versionId,
      auth.user.id,
      auth.deviceId,
      'restore',
    );
    await audit(db, auth.user.id, 'vault.item_restore', `vault:${vault.id}`, {
      itemId,
      versionId: body.versionId,
    }, clientIp(request));
    syncEvents.publish({
      type: 'vaultChanged',
      vaultId: vault.id,
      cursor: String(await vaultCursor(db, vault.id)),
    });
    return restored;
  });
}

export async function restoreSyncVersion(
  context: RouteContext,
  vaultId: string,
  itemId: string,
  versionId: string,
  actorUserId: string,
  deviceId: string | null,
  reason: 'restore' | 'admin_restore',
) {
  const { db } = context;
  const platform = await readSetting(db, 'platform');
  const restoredAt = nowIso();

  return await db.transaction(async () => {
    await lockSection(db, 'vault_storage');
    const version = await db.prepare(
      'SELECT * FROM sync_item_versions WHERE id = ? AND vault_id = ? AND item_id = ?',
    ).get<Record<string, unknown>>(versionId, vaultId, itemId);
    if (!version) throw new ApiError(404, 'version_not_found', 'That version does not exist');

    const cursor = await nextCursor(db);
    await db.prepare(
      `INSERT INTO sync_items
        (vault_id, item_id, item_type, ciphertext, nonce, schema_version,
         client_revision, updated_at, deleted_at, restored_at, cursor, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault_id, item_id) DO UPDATE SET
         item_type = excluded.item_type,
         ciphertext = excluded.ciphertext,
         nonce = excluded.nonce,
         schema_version = excluded.schema_version,
         client_revision = excluded.client_revision,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         restored_at = excluded.restored_at,
         cursor = excluded.cursor,
         stored_at = excluded.stored_at`,
    ).run(
      vaultId,
      itemId,
      version.item_type,
      version.ciphertext,
      version.nonce,
      version.schema_version,
      version.client_revision,
      version.updated_at,
      version.deleted_at ?? null,
      restoredAt,
      cursor,
      restoredAt,
    );

    await insertSyncVersion(db, {
      vaultId,
      itemId,
      itemType: String(version.item_type),
      ciphertext: String(version.ciphertext),
      nonce: String(version.nonce),
      schemaVersion: Number(version.schema_version),
      clientRevision: Number(version.client_revision),
      updatedAt: String(version.updated_at),
      deletedAt: (version.deleted_at as string | null) ?? null,
      restoredAt,
      versionCursor: cursor,
      storedAt: restoredAt,
      actorUserId,
      deviceId,
      reason,
    }, platform.itemVersionsKept);

    const row = await db.prepare('SELECT * FROM sync_items WHERE vault_id = ? AND item_id = ?')
      .get<SyncItemRow>(vaultId, itemId);
    return { restored: true, item: row ? publicSyncItem(row) : null };
  })();
}

async function listVaultMembers(context: RouteContext, vaultId: string) {
  const rows = await context.db.prepare(
    `SELECT u.id, u.email, u.display_name, u.disabled, vm.role, vm.created_at
     FROM vault_members vm
     JOIN users u ON u.id = vm.user_id
     WHERE vm.vault_id = ?
     ORDER BY vm.created_at ASC`,
  ).all<Pick<UserRow, 'id' | 'email' | 'display_name' | 'disabled'> & { role: string; created_at: string }>(vaultId);
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    disabled: Boolean(row.disabled),
    role: row.role,
    joinedAt: row.created_at,
  }));
}

async function countItems(context: RouteContext, vaultId: string): Promise<number> {
  const row = await context.db.prepare(
    'SELECT COUNT(*) AS count FROM sync_items WHERE vault_id = ? AND deleted_at IS NULL',
  ).get<{ count: number }>(vaultId);
  return Number(row?.count ?? 0);
}
