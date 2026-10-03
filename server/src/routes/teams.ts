import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { newId, nowIso } from '../config.js';
import { getUserByEmail, requireAuth } from '../auth/sessions.js';
import { sendMail } from '../email/mailer.js';
import { teamInviteEmail } from '../email/templates.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { TeamInviteRow, TeamRole, VaultRole } from '../lib/rows.js';
import { readSetting } from '../lib/settings.js';
import {
  assertVaultCreationAvailable,
  ensureVaultMember,
  getTeamAccess,
  listAccessibleTeams,
  publicTeam,
  requireTeamAccess,
  requireTeamAdmin,
  requireTeamOwner,
} from '../lib/vaults.js';
import {
  assertCanSync,
  assertNotInMaintenance,
  clientIp,
  emailSchema,
  idParam,
  publicOrigin,
  type RouteContext,
  vaultNameSchema,
} from './context.js';

const TEAM_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const teamRoleSchema = z.enum(['admin', 'member']);
const vaultRoleSchema = z.enum(['admin', 'editor', 'viewer']);

export function registerTeamRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config } = context;

  app.get('/v1/teams', async (request) => {
    const auth = await requireAuth(db, config, request);
    const teams = await listAccessibleTeams(db, auth.user.id);
    return { teams: await Promise.all(teams.map((team) => publicTeam(db, team, auth.user.id))) };
  });

  app.post('/v1/teams', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    await assertNotInMaintenance(context);

    const platform = await readSetting(db, 'platform');
    if (!platform.allowTeamCreation && auth.user.role !== 'admin') {
      throw new ApiError(
        403,
        'team_creation_disabled',
        'Only administrators can create teams on this server',
      );
    }
    await assertVaultCreationAvailable(db, config, auth.user.id);

    const body = z.object({
      name: vaultNameSchema,
      vaultName: vaultNameSchema.optional(),
    }).parse(request.body);

    const teamId = newId();
    const vaultId = newId();
    const now = nowIso();
    await db.transaction(async () => {
      await db.prepare(
        'INSERT INTO teams (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(teamId, body.name, auth.user.id, now, now);
      await db.prepare(
        `INSERT INTO team_members (team_id, user_id, role, default_vault_role, created_at, updated_at)
         VALUES (?, ?, 'owner', 'owner', ?, ?)`,
      ).run(teamId, auth.user.id, now, now);
      // A team without a vault has nothing to share, so one is created with it.
      await db.prepare(
        `INSERT INTO vaults (id, user_id, name, kind, team_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, 'team', ?, ?, ?, ?)`,
      ).run(vaultId, auth.user.id, body.vaultName ?? `${body.name} Vault`, teamId, auth.user.id, now, now);
      await ensureVaultMember(db, vaultId, auth.user.id, 'owner');
    })();

    await audit(db, auth.user.id, 'team.create', `team:${teamId}`, {
      name: body.name,
      vaultId,
    }, clientIp(request));
    return reply.code(201).send(
      await publicTeam(db, (await getTeamAccess(db, auth.user.id, teamId))!, auth.user.id),
    );
  });

  app.patch('/v1/teams/:id', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const team = await requireTeamAdmin(db, auth.user.id, idParam(request));
    const body = z.object({ name: vaultNameSchema }).parse(request.body);
    await db.prepare('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?')
      .run(body.name, nowIso(), team.id);
    await audit(db, auth.user.id, 'team.rename', `team:${team.id}`, { name: body.name }, clientIp(request));
    return await publicTeam(db, (await getTeamAccess(db, auth.user.id, team.id))!, auth.user.id);
  });

  app.delete('/v1/teams/:id', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const team = await requireTeamOwner(db, auth.user.id, idParam(request));
    await audit(db, auth.user.id, 'team.delete', `team:${team.id}`, { name: team.name }, clientIp(request));
    // Team vaults belong to the team, so they go with it. Personal vaults are
    // never attached to a team and are untouched.
    await db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
    return reply.code(204).send();
  });

  app.get('/v1/teams/:id/members', async (request) => {
    const auth = await requireAuth(db, config, request);
    const team = await requireTeamAccess(db, auth.user.id, idParam(request));
    return { members: await listTeamMembers(context, team.id) };
  });

  app.patch('/v1/teams/:id/members/:userId', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const { id, userId } = z.object({
      id: z.string().min(1).max(160),
      userId: z.string().min(1).max(160),
    }).parse(request.params);
    const team = await requireTeamAdmin(db, auth.user.id, id);
    const body = z.object({
      role: teamRoleSchema.optional(),
      vaultRole: vaultRoleSchema.optional(),
    }).parse(request.body);

    const target = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get<{ role: TeamRole }>(team.id, userId);
    if (!target) throw new ApiError(404, 'member_not_found', 'That account is not a member of this team');
    if (target.role === 'owner') {
      throw new ApiError(403, 'team_owner_locked', 'Transfer ownership to change the owner');
    }

    const now = nowIso();
    await db.transaction(async () => {
      if (body.role) {
        await db.prepare('UPDATE team_members SET role = ?, updated_at = ? WHERE team_id = ? AND user_id = ?')
          .run(body.role, now, team.id, userId);
      }
      if (body.vaultRole) {
        await db.prepare(
          'UPDATE team_members SET default_vault_role = ?, updated_at = ? WHERE team_id = ? AND user_id = ?',
        ).run(body.vaultRole, now, team.id, userId);
        // Applied to the team's existing vaults too. A role change that only
        // affected vaults created later would be a confusing half-measure.
        const vaults = await db.prepare("SELECT id FROM vaults WHERE team_id = ? AND kind = 'team'")
          .all<{ id: string }>(team.id);
        for (const vault of vaults) {
          await ensureVaultMember(db, vault.id, userId, body.vaultRole);
        }
      }
    })();

    await audit(db, auth.user.id, 'team.member_update', `team:${team.id}`, {
      userId,
      role: body.role ?? null,
      vaultRole: body.vaultRole ?? null,
    }, clientIp(request));
    return { members: await listTeamMembers(context, team.id) };
  });

  app.delete('/v1/teams/:id/members/:userId', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const { id, userId } = z.object({
      id: z.string().min(1).max(160),
      userId: z.string().min(1).max(160),
    }).parse(request.params);
    const team = await requireTeamAccess(db, auth.user.id, id);
    if (userId !== auth.user.id && team.member_role !== 'owner' && team.member_role !== 'admin') {
      throw new ApiError(403, 'team_admin_required', 'Team administrator access is required');
    }
    if (team.owner_user_id === userId) {
      throw new ApiError(409, 'team_owner_locked', 'Transfer ownership before removing the owner');
    }

    await db.transaction(async () => {
      await db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, userId);
      // Access to the team's vaults goes with the membership, otherwise a
      // removed member keeps pulling encrypted records they can still open.
      const vaults = await db.prepare("SELECT id FROM vaults WHERE team_id = ? AND kind = 'team'")
        .all<{ id: string }>(team.id);
      for (const vault of vaults) {
        await db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?')
          .run(vault.id, userId);
      }
    })();

    await audit(db, auth.user.id, 'team.member_remove', `team:${team.id}`, { userId }, clientIp(request));
    return reply.code(204).send();
  });

  app.post('/v1/teams/:id/transfer-ownership', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const team = await requireTeamOwner(db, auth.user.id, idParam(request));
    const body = z.object({ userId: z.string().min(1).max(160) }).parse(request.body);
    if (body.userId === auth.user.id) {
      throw new ApiError(400, 'already_owner', 'That account already owns this team');
    }
    const target = await db.prepare('SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(team.id, body.userId);
    if (!target) throw new ApiError(404, 'member_not_found', 'That account is not a member of this team');

    const now = nowIso();
    await db.transaction(async () => {
      await db.prepare('UPDATE teams SET owner_user_id = ?, updated_at = ? WHERE id = ?')
        .run(body.userId, now, team.id);
      await db.prepare(
        "UPDATE team_members SET role = 'owner', default_vault_role = 'owner', updated_at = ? WHERE team_id = ? AND user_id = ?",
      ).run(now, team.id, body.userId);
      // The previous owner stays as an administrator rather than losing access.
      await db.prepare("UPDATE team_members SET role = 'admin', updated_at = ? WHERE team_id = ? AND user_id = ?")
        .run(now, team.id, auth.user.id);
      // The team's vaults follow the team. Left on the previous owner, they
      // would be cascaded away with that account if it were ever deleted.
      await db.prepare('UPDATE vaults SET user_id = ?, updated_at = ? WHERE team_id = ?')
        .run(body.userId, now, team.id);
      const vaults = await db.prepare("SELECT id FROM vaults WHERE team_id = ? AND kind = 'team'")
        .all<{ id: string }>(team.id);
      for (const vault of vaults) {
        await ensureVaultMember(db, vault.id, body.userId, 'owner');
        await ensureVaultMember(db, vault.id, auth.user.id, 'admin');
      }
    })();

    await audit(db, auth.user.id, 'team.transfer_ownership', `team:${team.id}`, {
      newOwnerUserId: body.userId,
    }, clientIp(request));
    return await publicTeam(db, (await getTeamAccess(db, auth.user.id, team.id))!, auth.user.id);
  });

  app.get('/v1/teams/:id/invites', async (request) => {
    const auth = await requireAuth(db, config, request);
    const team = await requireTeamAdmin(db, auth.user.id, idParam(request));
    const rows = await db.prepare(
      `SELECT * FROM team_invites
       WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    ).all<TeamInviteRow>(team.id, nowIso());
    return { invites: rows.map(publicTeamInvite) };
  });

  app.post('/v1/teams/:id/invites', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const team = await requireTeamAdmin(db, auth.user.id, idParam(request));
    const body = z.object({
      email: emailSchema,
      role: teamRoleSchema.default('member'),
      vaultRole: vaultRoleSchema.default('editor'),
    }).parse(request.body);

    if (body.email === auth.user.email) {
      throw new ApiError(409, 'already_team_member', 'You already belong to this team');
    }
    const existingUser = await getUserByEmail(db, body.email);
    if (existingUser && await getTeamAccess(db, existingUser.id, team.id)) {
      throw new ApiError(409, 'already_team_member', 'That account already belongs to this team');
    }

    const token = randomToken('tin');
    const inviteId = newId();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + TEAM_INVITE_TTL_MS).toISOString();
    await db.transaction(async () => {
      // One live invitation per address per team; a re-invite replaces it
      // rather than leaving several working links in circulation.
      await db.prepare(
        `UPDATE team_invites SET revoked_at = ?
         WHERE team_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      ).run(now, team.id, body.email);
      await db.prepare(
        `INSERT INTO team_invites
          (id, team_id, email, role, vault_role, token_hash, invited_by_user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(inviteId, team.id, body.email, body.role, body.vaultRole, sha256(token), auth.user.id, expiresAt, now);
    })();

    const platform = await readSetting(db, 'platform');
    const inviteUrl = `${publicOrigin(config, request)}/invite/team?token=${encodeURIComponent(token)}`;
    const delivery = await sendMail(db, config, teamInviteEmail({
      serverName: platform.serverName,
      to: body.email,
      teamName: team.name,
      invitedBy: auth.user.display_name || auth.user.email,
      inviteUrl,
      expiresAt,
    }));

    await audit(db, auth.user.id, 'team.invite', `team:${team.id}`, {
      email: body.email,
      role: body.role,
      vaultRole: body.vaultRole,
      delivered: delivery.sent,
    }, clientIp(request));

    return reply.code(201).send({
      id: inviteId,
      teamId: team.id,
      teamName: team.name,
      email: body.email,
      role: body.role,
      vaultRole: body.vaultRole,
      // Returned once, so an operator without SMTP can copy the link by hand.
      token,
      inviteUrl,
      expiresAt,
      emailDelivered: delivery.sent,
      emailError: delivery.sent ? null : delivery.reason ?? null,
    });
  });

  app.delete('/v1/teams/:id/invites/:inviteId', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    const { id, inviteId } = z.object({
      id: z.string().min(1).max(160),
      inviteId: z.string().min(1).max(160),
    }).parse(request.params);
    const team = await requireTeamAdmin(db, auth.user.id, id);
    const revoked = await db.prepare(
      'UPDATE team_invites SET revoked_at = ? WHERE id = ? AND team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    ).run(nowIso(), inviteId, team.id);
    if (revoked.changes !== 1) throw new ApiError(404, 'invite_not_found', 'Invitation not found');
    await audit(db, auth.user.id, 'team.invite_revoke', `team:${team.id}`, { inviteId }, clientIp(request));
    return reply.code(204).send();
  });

  /** Lets the web interface show what an invitation is for before signing in. */
  app.get('/v1/team-invites/:token', async (request) => {
    const { token } = z.object({ token: z.string().min(10).max(400) }).parse(request.params);
    const invite = await findUsableTeamInvite(context, token);
    const team = await db.prepare('SELECT name FROM teams WHERE id = ?')
      .get<{ name: string }>(invite.team_id);
    return {
      teamId: invite.team_id,
      teamName: team?.name ?? 'Team',
      email: invite.email,
      role: invite.role,
      vaultRole: invite.vault_role,
      expiresAt: invite.expires_at,
    };
  });

  app.post('/v1/team-invites/:token/accept', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const { token } = z.object({ token: z.string().min(10).max(400) }).parse(request.params);
    const invite = await findUsableTeamInvite(context, token);

    // The invitation names an address; accepting it from another account would
    // let a forwarded link move team access to whoever received the forward.
    if (invite.email.toLowerCase() !== auth.user.email.toLowerCase()) {
      throw new ApiError(403, 'invite_email_mismatch', 'This invitation was sent to a different email address');
    }
    if (await getTeamAccess(db, auth.user.id, invite.team_id)) {
      throw new ApiError(409, 'already_team_member', 'You already belong to this team');
    }

    await db.transaction(async () => {
      await joinTeamFromInvite(context, invite, auth.user.id);
    })();

    await audit(db, auth.user.id, 'team.invite_accept', `team:${invite.team_id}`, null, clientIp(request));
    return await publicTeam(db, (await getTeamAccess(db, auth.user.id, invite.team_id))!, auth.user.id);
  });
}

/**
 * Claims a team invitation for `userId` and grants the team and its vaults.
 * Call inside a transaction: the claim is conditional, so two requests racing
 * one link cannot both join.
 */
export async function joinTeamFromInvite(
  context: RouteContext,
  invite: TeamInviteRow,
  userId: string,
): Promise<void> {
  const { db } = context;
  const now = nowIso();
  const claimed = await db.prepare(
    `UPDATE team_invites SET accepted_at = ?, accepted_by_user_id = ?
     WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
  ).run(now, userId, invite.id);
  if (claimed.changes !== 1) {
    throw new ApiError(409, 'invite_already_used', 'This invitation has already been used');
  }
  await db.prepare(
    `INSERT INTO team_members (team_id, user_id, role, default_vault_role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET
       role = excluded.role, default_vault_role = excluded.default_vault_role, updated_at = excluded.updated_at`,
  ).run(invite.team_id, userId, invite.role, invite.vault_role, now, now);
  const vaults = await db.prepare("SELECT id FROM vaults WHERE team_id = ? AND kind = 'team'")
    .all<{ id: string }>(invite.team_id);
  for (const vault of vaults) {
    await ensureVaultMember(db, vault.id, userId, invite.vault_role);
  }
}

export async function findUsableTeamInvite(context: RouteContext, token: string): Promise<TeamInviteRow> {
  const invite = await context.db.prepare('SELECT * FROM team_invites WHERE token_hash = ?')
    .get<TeamInviteRow>(sha256(token));
  if (
    !invite
    || invite.accepted_at
    || invite.revoked_at
    || Date.parse(invite.expires_at) <= Date.now()
  ) {
    throw new ApiError(404, 'invite_invalid', 'This invitation is invalid, used or expired');
  }
  return invite;
}

async function listTeamMembers(context: RouteContext, teamId: string) {
  const rows = await context.db.prepare(
    `SELECT u.id, u.email, u.display_name, u.disabled, tm.role, tm.default_vault_role, tm.created_at
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ?
     ORDER BY tm.created_at ASC`,
  ).all<{
    id: string;
    email: string;
    display_name: string | null;
    disabled: number;
    role: TeamRole;
    default_vault_role: VaultRole;
    created_at: string;
  }>(teamId);
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    disabled: Boolean(row.disabled),
    role: row.role,
    vaultRole: row.default_vault_role,
    joinedAt: row.created_at,
  }));
}

function publicTeamInvite(invite: TeamInviteRow) {
  return {
    id: invite.id,
    teamId: invite.team_id,
    email: invite.email,
    role: invite.role,
    vaultRole: invite.vault_role,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  };
}
