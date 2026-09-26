import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { newId, nowIso, secretIsGenerated } from '../config.js';
import { scalar } from '../db/database.js';
import { disableMfa, isMfaEnabled } from '../auth/mfa.js';
import { getUserByEmail, requireAdmin, revokeAllSessions } from '../auth/sessions.js';
import { resolveSmtp, sendMail, verifySmtp } from '../email/mailer.js';
import { accountInviteEmail, testEmail } from '../email/templates.js';
import { assertOwnsNoTeams, deleteAccount } from '../lib/accounts.js';
import { audit, pruneAuditLog } from '../lib/audit.js';
import { hashPassword, randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { AccountInviteRow, UserRow } from '../lib/rows.js';
import {
  DEFAULT_SMTP_SETTINGS,
  encryptSmtpPassword,
  platformSettingsSchema,
  readSetting,
  smtpSettingsSchema,
  writeSetting,
} from '../lib/settings.js';
import { vaultStorageBytes } from '../lib/vaults.js';
import { invalidatePasswordResetTokens, publicUser } from './auth.js';
import {
  clientIp,
  emailSchema,
  idParam,
  passwordSchema,
  publicOrigin,
  type RouteContext,
} from './context.js';

const ACCOUNT_INVITE_TTL_DAYS = 14;

export function registerAdminRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config } = context;

  app.get('/v1/admin/overview', async (request) => {
    await requireAdmin(db, config, request);
    const [users, admins, disabled, teams, vaults, items, devices] = await Promise.all([
      scalar(db, 'SELECT COUNT(*) AS count FROM users'),
      scalar(db, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"),
      scalar(db, 'SELECT COUNT(*) AS count FROM users WHERE disabled = 1'),
      scalar(db, 'SELECT COUNT(*) AS count FROM teams'),
      scalar(db, 'SELECT COUNT(*) AS count FROM vaults'),
      scalar(db, 'SELECT COUNT(*) AS count FROM sync_items WHERE deleted_at IS NULL'),
      scalar(db, 'SELECT COUNT(*) AS count FROM devices'),
    ]);
    const encryptedBytes = await scalar(
      db,
      'SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(nonce)), 0) AS bytes FROM sync_items',
    );
    const activeWeek = await scalar(
      db,
      'SELECT COUNT(*) AS count FROM users WHERE last_seen_at > ?',
      [new Date(Date.now() - 7 * 86_400_000).toISOString()],
    );
    const recent = await db.prepare(
      `SELECT a.id, a.action, a.target, a.created_at, u.email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.created_at DESC LIMIT 10`,
    ).all<{ id: string; action: string; target: string | null; created_at: string; email: string | null }>();

    return {
      users: { total: users, admins, disabled, activeLastWeek: activeWeek },
      teams,
      vaults,
      syncItems: items,
      devices,
      encryptedBytes,
      recentActivity: recent.map((row) => ({
        id: row.id,
        action: row.action,
        target: row.target,
        actorEmail: row.email,
        createdAt: row.created_at,
      })),
    };
  });

  app.get('/v1/admin/users', async (request) => {
    await requireAdmin(db, config, request);
    const query = z.object({
      search: z.string().trim().max(200).optional(),
      role: z.enum(['admin', 'user']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);

    const filters: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      filters.push('(LOWER(email) LIKE ? OR LOWER(COALESCE(display_name, \'\')) LIKE ?)');
      const pattern = `%${query.search.toLowerCase()}%`;
      params.push(pattern, pattern);
    }
    if (query.role) {
      filters.push('role = ?');
      params.push(query.role);
    }
    if (query.status) {
      filters.push('disabled = ?');
      params.push(query.status === 'disabled' ? 1 : 0);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = await db.prepare(
      `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all<UserRow>(...params, query.limit, query.offset);
    const total = await scalar(db, `SELECT COUNT(*) AS count FROM users ${where}`, params);

    return {
      total,
      users: await Promise.all(rows.map(async (user) => ({
        ...publicUser(user),
        mfaEnabled: await isMfaEnabled(db, user.id),
        vaults: await scalar(db, 'SELECT COUNT(*) AS count FROM vault_members WHERE user_id = ?', [user.id]),
        devices: await scalar(db, 'SELECT COUNT(*) AS count FROM devices WHERE user_id = ?', [user.id]),
      }))),
    };
  });

  app.get('/v1/admin/users/:id', async (request) => {
    await requireAdmin(db, config, request);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get<UserRow>(idParam(request));
    if (!user) throw new ApiError(404, 'user_not_found', 'Account not found');

    const vaults = await db.prepare(
      `SELECT v.id, v.name, v.kind, vm.role FROM vaults v
       JOIN vault_members vm ON vm.vault_id = v.id WHERE vm.user_id = ?`,
    ).all<{ id: string; name: string; kind: string; role: string }>(user.id);
    const devices = await db.prepare(
      'SELECT id, name, platform, last_seen_at, created_at FROM devices WHERE user_id = ? ORDER BY created_at DESC',
    ).all<Record<string, unknown>>(user.id);
    const teams = await db.prepare(
      `SELECT t.id, t.name, tm.role FROM teams t
       JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?`,
    ).all<{ id: string; name: string; role: string }>(user.id);

    return {
      ...publicUser(user),
      mfaEnabled: await isMfaEnabled(db, user.id),
      vaults,
      teams,
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        lastSeenAt: device.last_seen_at,
        createdAt: device.created_at,
      })),
    };
  });

  app.patch('/v1/admin/users/:id', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const id = idParam(request);
    const body = z.object({
      role: z.enum(['admin', 'user']).optional(),
      disabled: z.boolean().optional(),
      disabledReason: z.string().trim().max(200).optional(),
      displayName: z.string().trim().max(80).nullable().optional(),
      emailVerified: z.boolean().optional(),
    }).parse(request.body);

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get<UserRow>(id);
    if (!user) throw new ApiError(404, 'user_not_found', 'Account not found');

    // An administrator must not be able to lock themselves out, and the last
    // administrator must not be removed at all: there would be no way back in.
    if (user.id === auth.user.id && body.disabled === true) {
      throw new ApiError(409, 'cannot_disable_self', 'You cannot disable your own account');
    }
    if (
      user.role === 'admin'
      && (body.role === 'user' || body.disabled === true)
      && await scalar(db, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0") <= 1
    ) {
      throw new ApiError(409, 'last_admin', 'This is the only administrator on this server');
    }

    const now = nowIso();
    await db.transaction(async () => {
      if (body.role !== undefined) {
        await db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(body.role, now, id);
      }
      if (body.disabled !== undefined) {
        await db.prepare('UPDATE users SET disabled = ?, disabled_reason = ?, updated_at = ? WHERE id = ?')
          .run(body.disabled ? 1 : 0, body.disabled ? body.disabledReason ?? null : null, now, id);
      }
      if (body.displayName !== undefined) {
        await db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
          .run(body.displayName?.trim() || null, now, id);
      }
      if (body.emailVerified !== undefined) {
        await db.prepare('UPDATE users SET email_verified = ?, updated_at = ? WHERE id = ?')
          .run(body.emailVerified ? 1 : 0, now, id);
      }
    })();

    // Disabling has to end sessions, or the account keeps syncing until every
    // access token happens to expire.
    if (body.disabled === true) await revokeAllSessions(db, id);

    // Every field that changed is recorded. Marking an address verified or
    // renaming an account changes what others see and trust, so it belongs in
    // the trail as much as a role change does.
    await audit(db, auth.user.id, 'admin.user_update', `user:${id}`, {
      role: body.role ?? null,
      disabled: body.disabled ?? null,
      disabledReason: body.disabled === true ? body.disabledReason ?? null : null,
      emailVerified: body.emailVerified ?? null,
      displayName: body.displayName !== undefined ? body.displayName?.trim() || null : null,
      changed: Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined),
    }, clientIp(request));
    return publicUser((await db.prepare('SELECT * FROM users WHERE id = ?').get<UserRow>(id))!);
  });

  app.post('/v1/admin/users/:id/revoke-sessions', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const id = idParam(request);
    await db.prepare('DELETE FROM devices WHERE user_id = ?').run(id);
    await revokeAllSessions(db, id);
    await audit(db, auth.user.id, 'admin.revoke_sessions', `user:${id}`, null, clientIp(request));
    return { revoked: true };
  });

  /**
   * Sets a new password directly.
   *
   * The operator of a self-hosted server is the recovery path when there is no
   * SMTP to send a reset link. It is a real privilege, so it is audited and it
   * signs every session out.
   */
  app.post('/v1/admin/users/:id/password', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const id = idParam(request);
    const body = z.object({ newPassword: passwordSchema }).parse(request.body);
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError(404, 'user_not_found', 'Account not found');

    await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(await hashPassword(body.newPassword), nowIso(), id);
    await invalidatePasswordResetTokens(db, id);
    await revokeAllSessions(db, id);
    await audit(db, auth.user.id, 'admin.password_set', `user:${id}`, null, clientIp(request));
    return { updated: true };
  });

  /**
   * Clears an account's second factor.
   *
   * Someone who lost both their authenticator and their recovery codes has no
   * other way back in on a server the operator controls.
   */
  app.delete('/v1/admin/users/:id/mfa', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const id = idParam(request);
    await disableMfa(db, id);
    await revokeAllSessions(db, id);
    await audit(db, auth.user.id, 'admin.mfa_reset', `user:${id}`, null, clientIp(request));
    return { reset: true };
  });

  app.delete('/v1/admin/users/:id', async (request, reply) => {
    const auth = await requireAdmin(db, config, request);
    const id = idParam(request);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get<UserRow>(id);
    if (!user) throw new ApiError(404, 'user_not_found', 'Account not found');
    if (user.id === auth.user.id) {
      throw new ApiError(409, 'cannot_delete_self', 'Delete your own account from account settings');
    }
    if (
      user.role === 'admin'
      && await scalar(db, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0") <= 1
    ) {
      throw new ApiError(409, 'last_admin', 'This is the only administrator on this server');
    }
    await assertOwnsNoTeams(db, id);
    await audit(db, auth.user.id, 'admin.user_delete', `user:${id}`, {
      email: user.email,
    }, clientIp(request));
    await deleteAccount(db, id);
    return reply.code(204).send();
  });

  app.get('/v1/admin/invites', async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.prepare(
      `SELECT i.*, c.email AS created_by_email, u.email AS used_by_email
       FROM account_invites i
       LEFT JOIN users c ON c.id = i.created_by_user_id
       LEFT JOIN users u ON u.id = i.used_by_user_id
       ORDER BY i.created_at DESC LIMIT 200`,
    ).all<AccountInviteRow & { created_by_email: string | null; used_by_email: string | null }>();
    return { invites: rows.map(publicAccountInvite) };
  });

  app.post('/v1/admin/invites', async (request, reply) => {
    const auth = await requireAdmin(db, config, request);
    const body = z.object({
      email: emailSchema.optional(),
      role: z.enum(['admin', 'user']).default('user'),
      note: z.string().trim().max(200).default(''),
      expiresInDays: z.number().int().min(1).max(90).default(ACCOUNT_INVITE_TTL_DAYS),
    }).parse(request.body ?? {});

    if (body.email && await getUserByEmail(db, body.email)) {
      throw new ApiError(409, 'account_exists', 'An account with this email already exists');
    }

    const token = randomToken('ain');
    const inviteId = newId();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
    await db.prepare(
      `INSERT INTO account_invites
        (id, token_hash, email, role, note, created_by_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(inviteId, sha256(token), body.email ?? '', body.role, body.note, auth.user.id, expiresAt, nowIso());

    const platform = await readSetting(db, 'platform');
    const inviteUrl = `${publicOrigin(config, request)}/signup?invite=${encodeURIComponent(token)}`;
    const delivery = body.email
      ? await sendMail(db, config, accountInviteEmail({
        serverName: platform.serverName,
        to: body.email,
        invitedBy: auth.user.display_name || auth.user.email,
        inviteUrl,
        expiresAt,
      }))
      : { sent: false, reason: 'no_recipient' as const };

    await audit(db, auth.user.id, 'admin.invite_create', `invite:${inviteId}`, {
      email: body.email ?? null,
      role: body.role,
      delivered: delivery.sent,
    }, clientIp(request));

    return reply.code(201).send({
      id: inviteId,
      email: body.email ?? '',
      role: body.role,
      note: body.note,
      expiresAt,
      // Shown once. Without SMTP this is the whole delivery mechanism, so the
      // admin interface displays it to copy.
      token,
      inviteUrl,
      emailDelivered: delivery.sent,
      emailError: delivery.sent ? null : delivery.reason ?? null,
    });
  });

  app.delete('/v1/admin/invites/:id', async (request, reply) => {
    const auth = await requireAdmin(db, config, request);
    const id = idParam(request);
    const revoked = await db.prepare(
      'UPDATE account_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
    ).run(nowIso(), id);
    if (revoked.changes !== 1) throw new ApiError(404, 'invite_not_found', 'Invitation not found');
    await audit(db, auth.user.id, 'admin.invite_revoke', `invite:${id}`, null, clientIp(request));
    return reply.code(204).send();
  });

  app.get('/v1/admin/vaults', async (request) => {
    await requireAdmin(db, config, request);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const rows = await db.prepare(
      `SELECT v.*, u.email AS owner_email, t.name AS team_name
       FROM vaults v
       LEFT JOIN users u ON u.id = v.user_id
       LEFT JOIN teams t ON t.id = v.team_id
       ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    ).all<Record<string, unknown>>(query.limit, query.offset);

    return {
      total: await scalar(db, 'SELECT COUNT(*) AS count FROM vaults'),
      // Metadata only. The admin interface deliberately offers no way to read
      // a record: the server holds ciphertext it cannot open, and an operator
      // should not be given the impression otherwise.
      vaults: await Promise.all(rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        ownerEmail: row.owner_email,
        teamName: row.team_name,
        members: await scalar(db, 'SELECT COUNT(*) AS count FROM vault_members WHERE vault_id = ?', [row.id]),
        items: await scalar(
          db,
          'SELECT COUNT(*) AS count FROM sync_items WHERE vault_id = ? AND deleted_at IS NULL',
          [row.id],
        ),
        storageBytes: await vaultStorageBytes(db, String(row.id)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))),
    };
  });

  app.get('/v1/admin/audit', async (request) => {
    await requireAdmin(db, config, request);
    const query = z.object({
      action: z.string().trim().max(80).optional(),
      actorUserId: z.string().trim().max(160).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);

    const filters: string[] = [];
    const params: unknown[] = [];
    if (query.action) {
      filters.push('a.action LIKE ?');
      params.push(`${query.action}%`);
    }
    if (query.actorUserId) {
      filters.push('a.actor_user_id = ?');
      params.push(query.actorUserId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = await db.prepare(
      `SELECT a.*, u.email FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ).all<Record<string, unknown>>(...params, query.limit, query.offset);

    return {
      total: await scalar(db, `SELECT COUNT(*) AS count FROM audit_log a ${where}`, params),
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        target: row.target,
        actorUserId: row.actor_user_id,
        actorEmail: row.email,
        detail: row.detail_json ? safeParse(String(row.detail_json)) : null,
        ip: row.ip,
        createdAt: row.created_at,
      })),
    };
  });

  app.get('/v1/admin/settings', async (request) => {
    await requireAdmin(db, config, request);
    const platform = await readSetting(db, 'platform');
    const smtp = await readSetting(db, 'smtp');
    return {
      platform,
      smtp: {
        ...smtp,
        // The stored password never leaves the server, in either direction.
        passwordEncrypted: undefined,
        passwordSet: Boolean(smtp.passwordEncrypted),
      },
      environmentSmtpConfigured: Boolean(config.smtp.host),
    };
  });

  app.put('/v1/admin/settings/platform', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const body = platformSettingsSchema.parse(request.body);
    if (body.registrationMode === 'domain' && body.allowedEmailDomains.length === 0) {
      throw new ApiError(
        400,
        'domains_required',
        'Domain registration needs at least one allowed domain',
      );
    }
    const previous = await readSetting(db, 'platform');
    await writeSetting(db, 'platform', body, auth.user.id);
    if (body.auditRetentionDays > 0) await pruneAuditLog(db, body.auditRetentionDays);
    // Platform settings hold no secrets, so the changed keys and their new
    // values are recorded in full. Turning email verification off or opening
    // sign-up is exactly what an operator needs to find in the trail later.
    const changed = (Object.keys(body) as (keyof typeof body)[])
      .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(body[key]));
    await audit(db, auth.user.id, 'admin.settings_platform', null, {
      changed,
      values: Object.fromEntries(changed.map((key) => [key, body[key]])),
      registrationMode: body.registrationMode,
      maintenanceMode: body.maintenanceMode,
    }, clientIp(request));
    return await readSetting(db, 'platform');
  });

  app.put('/v1/admin/settings/smtp', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const body = smtpSettingsSchema
      .omit({ passwordEncrypted: true })
      .extend({ password: z.string().max(512).optional() })
      .parse(request.body);

    const current = await readSetting(db, 'smtp');
    if (body.enabled && !body.host) {
      throw new ApiError(400, 'smtp_host_required', 'Enter an SMTP host');
    }
    await writeSetting(db, 'smtp', {
      ...DEFAULT_SMTP_SETTINGS,
      enabled: body.enabled,
      host: body.host,
      port: body.port,
      security: body.security,
      user: body.user,
      from: body.from,
      // An omitted password means "leave it as it is", so saving other fields
      // does not silently wipe a working credential.
      passwordEncrypted: body.password === undefined
        ? current.passwordEncrypted
        : encryptSmtpPassword(config.settingsEncryptionKey, body.password),
    }, auth.user.id);

    await audit(db, auth.user.id, 'admin.settings_smtp', null, {
      enabled: body.enabled,
      host: body.host,
    }, clientIp(request));
    return { saved: true };
  });

  app.post('/v1/admin/settings/smtp/test', async (request) => {
    const auth = await requireAdmin(db, config, request);
    const body = z.object({ to: emailSchema.optional() }).parse(request.body ?? {});
    const smtp = await resolveSmtp(db, config);
    if (!smtp) throw new ApiError(400, 'smtp_not_configured', 'Configure SMTP before testing it');

    const reachable = await verifySmtp(smtp);
    if (!reachable.ok) return { ok: false, stage: 'connect', error: reachable.error };

    const platform = await readSetting(db, 'platform');
    const delivery = await sendMail(db, config, testEmail({
      serverName: platform.serverName,
      to: body.to ?? auth.user.email,
    }));
    await audit(db, auth.user.id, 'admin.smtp_test', null, { ok: delivery.sent }, clientIp(request));
    return delivery.sent
      ? { ok: true, stage: 'sent' }
      : { ok: false, stage: 'send', error: delivery.reason };
  });

  /**
   * Operational health, including whether this deployment is running on
   * secrets that were generated at boot and will not survive a restart.
   */
  app.get('/v1/admin/system', async (request) => {
    await requireAdmin(db, config, request);
    const smtp = await resolveSmtp(db, config);
    const warnings: string[] = [];
    if (secretIsGenerated(config.jwtSecret)) {
      warnings.push('SYNC_JWT_SECRET is generated at startup. Every restart signs all clients out. Set it in the environment.');
    }
    if (config.nodeEnv !== 'production') {
      warnings.push(`NODE_ENV is "${config.nodeEnv}". Set NODE_ENV=production for a real deployment.`);
    }
    if (!config.publicUrl) {
      warnings.push('PUBLIC_URL is unset. Invitation and reset links are built from request headers.');
    }
    if (!smtp) {
      warnings.push('No SMTP configured. Invitations and password resets must be delivered by hand.');
    }

    return {
      version: config.version,
      nodeVersion: process.version,
      nodeEnv: config.nodeEnv,
      database: db.dialect,
      uptimeSeconds: Math.floor(process.uptime()),
      publicUrl: config.publicUrl || null,
      smtpConfigured: Boolean(smtp),
      limits: {
        vaultStorageBytes: config.limits.vaultStorageBytes,
        vaultsPerUser: config.limits.vaultsPerUser,
      },
      rateLimitEnabled: config.rateLimit.enabled,
      warnings,
    };
  });
}

function publicAccountInvite(
  invite: AccountInviteRow & { created_by_email?: string | null; used_by_email?: string | null },
) {
  const expired = Date.parse(invite.expires_at) <= Date.now();
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    note: invite.note,
    status: invite.used_at ? 'used' : invite.revoked_at ? 'revoked' : expired ? 'expired' : 'pending',
    createdByEmail: invite.created_by_email ?? null,
    usedByEmail: invite.used_by_email ?? null,
    expiresAt: invite.expires_at,
    usedAt: invite.used_at,
    createdAt: invite.created_at,
  };
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
