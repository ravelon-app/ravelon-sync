import { type Config, newId, nowIso } from '../config.js';
import { type AppDatabase, lockSection, scalar } from '../db/database.js';
import { ApiError } from './errors.js';
import type {
  TeamAccessRow,
  TeamRole,
  VaultAccessRow,
  VaultRole,
} from './rows.js';

export const VAULT_ROLES: readonly VaultRole[] = ['owner', 'admin', 'editor', 'viewer'];

export function vaultRoleCanWrite(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

export function vaultRoleCanAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export function teamRoleCanAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function getVaultAccess(
  db: AppDatabase,
  userId: string,
  vaultId: string,
): Promise<VaultAccessRow | undefined> {
  return await db.prepare(
    `SELECT v.*, vm.role AS member_role
     FROM vaults v
     JOIN vault_members vm ON vm.vault_id = v.id
     WHERE v.id = ? AND vm.user_id = ?`,
  ).get<VaultAccessRow>(vaultId, userId);
}

export async function requireVaultAccess(
  db: AppDatabase,
  userId: string,
  vaultId: string,
): Promise<VaultAccessRow> {
  const vault = await getVaultAccess(db, userId, vaultId);
  // Deliberately the same answer whether the vault does not exist or the
  // caller simply has no membership: probing must not reveal which.
  if (!vault) throw new ApiError(403, 'vault_not_accessible', 'Vault not found or not accessible');
  return vault;
}

export async function requireVaultWrite(
  db: AppDatabase,
  userId: string,
  vaultId: string,
): Promise<VaultAccessRow> {
  const vault = await requireVaultAccess(db, userId, vaultId);
  if (!vaultRoleCanWrite(vault.member_role)) {
    throw new ApiError(403, 'vault_write_required', 'This vault is read-only for your role');
  }
  return vault;
}

export async function listAccessibleVaults(
  db: AppDatabase,
  userId: string,
): Promise<VaultAccessRow[]> {
  return await db.prepare(
    `SELECT v.*, vm.role AS member_role
     FROM vaults v
     JOIN vault_members vm ON vm.vault_id = v.id
     WHERE vm.user_id = ?
     ORDER BY v.kind ASC, v.created_at ASC, v.id ASC`,
  ).all<VaultAccessRow>(userId);
}

export async function ensureVaultMember(
  db: AppDatabase,
  vaultId: string,
  userId: string,
  role: VaultRole,
): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO vault_members (vault_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  ).run(vaultId, userId, role, now, now);
}

/** Creates the personal vault every account starts with. */
export async function ensurePersonalVault(
  db: AppDatabase,
  userId: string,
  name = 'Personal Vault',
): Promise<VaultAccessRow> {
  const existing = await db.prepare(
    `SELECT v.*, vm.role AS member_role
     FROM vaults v
     JOIN vault_members vm ON vm.vault_id = v.id
     WHERE vm.user_id = ? AND v.kind = 'personal' AND v.user_id = ?
     ORDER BY v.created_at ASC`,
  ).get<VaultAccessRow>(userId, userId);
  if (existing) return existing;

  const id = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO vaults (id, user_id, name, kind, team_id, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'personal', NULL, ?, ?, ?)`,
  ).run(id, userId, name, userId, now, now);
  await ensureVaultMember(db, id, userId, 'owner');
  return (await getVaultAccess(db, userId, id))!;
}

/**
 * Resolves the vault id a client sent, creating it if the client owns the name.
 *
 * Ravelon clients address their own vault by a stable local id such as
 * `personal-vault` and expect the server to adopt it on first sync. An id that
 * already belongs to somebody else is refused rather than silently reassigned.
 */
export async function ensureVaultForClientId(
  db: AppDatabase,
  config: Config,
  userId: string,
  clientVaultId: string,
): Promise<VaultAccessRow> {
  const current = await getVaultAccess(db, userId, clientVaultId);
  if (current) return current;

  // Check and insert run under one lock. Two first pushes from the same
  // account arrive together often (two devices, or a retry), and without it
  // both pass the checks: one then fails on the primary key, and the vault
  // limit can be exceeded by racing requests.
  await db.transaction(async () => {
    await lockSection(db, 'vault_create');
    if (await getVaultAccess(db, userId, clientVaultId)) return;
    const occupied = await db.prepare('SELECT id FROM vaults WHERE id = ?').get(clientVaultId);
    if (occupied) throw new ApiError(403, 'vault_not_accessible', 'Vault not found or not accessible');

    await assertVaultCreationAvailable(db, config, userId);
    const now = nowIso();
    await db.prepare(
      `INSERT INTO vaults (id, user_id, name, kind, team_id, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'Personal Vault', 'personal', NULL, ?, ?, ?)`,
    ).run(clientVaultId, userId, userId, now, now);
    await ensureVaultMember(db, clientVaultId, userId, 'owner');
  })();
  const created = await getVaultAccess(db, userId, clientVaultId);
  if (!created) throw new ApiError(403, 'vault_not_accessible', 'Vault not found or not accessible');
  return created;
}

export async function assertVaultCreationAvailable(
  db: AppDatabase,
  config: Config,
  userId: string,
): Promise<void> {
  const owned = await scalar(db, 'SELECT COUNT(*) AS count FROM vaults WHERE user_id = ?', [userId]);
  if (owned >= config.limits.vaultsPerUser) {
    throw new ApiError(
      409,
      'vault_limit_reached',
      `This deployment allows ${config.limits.vaultsPerUser} vaults per account`,
    );
  }
}

export async function vaultStorageBytes(db: AppDatabase, vaultId: string): Promise<number> {
  const items = await scalar(
    db,
    'SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(nonce)), 0) AS bytes FROM sync_items WHERE vault_id = ?',
    [vaultId],
  );
  const versions = await scalar(
    db,
    'SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(nonce)), 0) AS bytes FROM sync_item_versions WHERE vault_id = ?',
    [vaultId],
  );
  const snapshot = await scalar(
    db,
    'SELECT COALESCE(LENGTH(blob), 0) AS bytes FROM desktop_vault_blobs WHERE vault_id = ?',
    [vaultId],
  );
  return items + versions + snapshot;
}

export async function getTeamAccess(
  db: AppDatabase,
  userId: string,
  teamId: string,
): Promise<TeamAccessRow | undefined> {
  return await db.prepare(
    `SELECT t.*, tm.role AS member_role, tm.default_vault_role
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE t.id = ? AND tm.user_id = ?`,
  ).get<TeamAccessRow>(teamId, userId);
}

export async function requireTeamAccess(
  db: AppDatabase,
  userId: string,
  teamId: string,
): Promise<TeamAccessRow> {
  const team = await getTeamAccess(db, userId, teamId);
  if (!team) throw new ApiError(403, 'team_not_accessible', 'Team not found or not accessible');
  return team;
}

export async function requireTeamAdmin(
  db: AppDatabase,
  userId: string,
  teamId: string,
): Promise<TeamAccessRow> {
  const team = await requireTeamAccess(db, userId, teamId);
  if (!teamRoleCanAdmin(team.member_role)) {
    throw new ApiError(403, 'team_admin_required', 'Team administrator access is required');
  }
  return team;
}

export async function requireTeamOwner(
  db: AppDatabase,
  userId: string,
  teamId: string,
): Promise<TeamAccessRow> {
  const team = await requireTeamAccess(db, userId, teamId);
  if (team.member_role !== 'owner') {
    throw new ApiError(403, 'team_owner_required', 'Only the team owner can do this');
  }
  return team;
}

export async function listAccessibleTeams(db: AppDatabase, userId: string): Promise<TeamAccessRow[]> {
  return await db.prepare(
    `SELECT t.*, tm.role AS member_role, tm.default_vault_role
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = ?
     ORDER BY t.created_at ASC`,
  ).all<TeamAccessRow>(userId);
}

/** The client-facing shape of a vault, matching what Ravelon clients decode. */
export function publicVault(vault: VaultAccessRow) {
  return {
    id: vault.id,
    name: vault.name,
    kind: vault.kind,
    role: vault.member_role,
    teamId: vault.team_id,
    createdAt: vault.created_at,
    updatedAt: vault.updated_at,
  };
}

/**
 * The client-facing shape of a team.
 *
 * `vaults` lists only the team vaults this caller is actually a member of, so
 * a team member never learns about a vault they were not added to.
 */
export async function publicTeam(db: AppDatabase, team: TeamAccessRow, viewerUserId: string) {
  const members = await scalar(
    db,
    'SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?',
    [team.id],
  );
  const vaults = await db.prepare(
    `SELECT v.*, vm.role AS member_role
     FROM vaults v
     JOIN vault_members vm ON vm.vault_id = v.id
     WHERE v.team_id = ? AND vm.user_id = ?
     ORDER BY v.created_at ASC`,
  ).all<VaultAccessRow>(team.id, viewerUserId);
  return {
    id: team.id,
    name: team.name,
    role: team.member_role,
    ownerUserId: team.owner_user_id,
    members,
    vaults: vaults.map(publicVault),
    createdAt: team.created_at,
    updatedAt: team.updated_at,
  };
}

export function normalizeTeamRole(role: string): TeamRole {
  return role === 'owner' || role === 'admin' ? role : 'member';
}
