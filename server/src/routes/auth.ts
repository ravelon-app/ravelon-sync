import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { newId, nowIso } from '../config.js';
import { lockSection, scalar } from '../db/database.js';
import {
  getUserByEmail,
  getUserById,
  issueSession,
  requireAuth,
  revokeAllSessions,
  revokeSessionByRefreshToken,
  rotateRefreshToken,
} from '../auth/sessions.js';
import { completeMfaChallenge, isMfaEnabled, issueMfaChallenge } from '../auth/mfa.js';
import { mfaUserFailKey, verifyReauth } from '../auth/reauth.js';
import type { AppDatabase } from '../db/database.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import type { AccountInviteRow, UserRow } from '../lib/rows.js';
import { readSetting } from '../lib/settings.js';
import { ensurePersonalVault } from '../lib/vaults.js';
import { sendMail } from '../email/mailer.js';
import { emailVerificationEmail, passwordResetEmail } from '../email/templates.js';
import {
  clientIp,
  deviceNameSchema,
  emailSchema,
  mfaCodeSchema,
  passwordSchema,
  platformSchema,
  publicOrigin,
  type RouteContext,
} from './context.js';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional(),
  deviceName: deviceNameSchema.optional(),
  platform: platformSchema.optional(),
  inviteToken: z.string().trim().min(10).max(200).optional(),
  /** Present on clients that can complete a second factor. */
  mfaSupported: z.boolean().optional(),
});

const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(512),
  deviceName: deviceNameSchema.optional(),
  platform: platformSchema.optional(),
  mfaSupported: z.boolean().optional(),
});

export function registerAuthRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, limiter } = context;

  app.post('/v1/auth/register', async (request, reply) => {
    limiter.hit(`auth:${clientIp(request)}`, config.rateLimit.authPerIpPerMin);
    const body = registerBody.parse(request.body);

    // Policy first: on an invite-only or closed server, answering
    // account_exists before the policy refusal would let anyone probe which
    // addresses have accounts here.
    const invite = await checkRegistrationAllowed(context, body.email, body.inviteToken);
    if (await getUserByEmail(db, body.email)) {
      throw new ApiError(409, 'account_exists', 'An account with this email already exists');
    }

    const userId = newId();
    const now = nowIso();
    const passwordHash = await hashPassword(body.password);

    await db.transaction(async () => {
      // Held for this transaction only. Without it, two people registering at
      // the same moment on an empty deployment would both read zero accounts
      // and both be made administrator.
      await lockSection(db, 'user_bootstrap');
      // Re-checked inside the transaction: two people registering the same
      // address at once must not both succeed.
      if (await getUserByEmail(db, body.email)) {
        throw new ApiError(409, 'account_exists', 'An account with this email already exists');
      }
      // A deployment's first account is always its administrator, whatever an
      // invitation says. There is nobody else to grant that role.
      const isFirstAccount = await scalar(db, 'SELECT COUNT(*) AS count FROM users') === 0;
      const role = isFirstAccount ? 'admin' : invite?.role === 'admin' ? 'admin' : 'user';

      await db.prepare(
        `INSERT INTO users
          (id, email, password_hash, display_name, email_verified, role, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`,
      ).run(userId, body.email, passwordHash, body.displayName?.trim() || null, role, now, now);

      if (invite) {
        // Consumed in the same transaction, so two people racing one link
        // cannot both get an account out of it.
        const consumed = await db.prepare(
          `UPDATE account_invites SET used_at = ?, used_by_user_id = ?
           WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        ).run(now, userId, invite.id);
        if (consumed.changes !== 1) {
          throw new ApiError(409, 'invite_already_used', 'This invitation has already been used');
        }
      }

      await ensurePersonalVault(db, userId);
      await audit(db, userId, 'auth.register', `user:${userId}`, {
        role,
        bootstrap: isFirstAccount,
        inviteId: invite?.id ?? null,
      }, clientIp(request));
    })();

    const session = await issueSession(
      db,
      config,
      userId,
      body.deviceName ?? 'Ravelon Web',
      body.platform ?? 'web',
      { ip: clientIp(request) },
    );
    void requestEmailVerification(context, request, userId, body.email).catch(() => {
      // A deployment without SMTP is normal; verification stays available from
      // the account page.
    });
    return reply.code(201).send({ ...session, isNewUser: true });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    limiter.hit(`auth:${clientIp(request)}`, config.rateLimit.authPerIpPerMin);
    const body = loginBody.parse(request.body);

    const failKey = `auth-fail:${body.email}`;
    if (limiter.isLockedOut(failKey)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed attempts. Try again later');
    }

    const user = await getUserByEmail(db, body.email);
    // The password is verified even for an unknown address, so the response
    // time does not tell an attacker which addresses exist here.
    const passwordValid = user
      ? await verifyPassword(body.password, user.password_hash)
      : await verifyPassword(body.password, DUMMY_HASH);
    if (!user || !passwordValid) {
      limiter.recordFailure(failKey);
      // The attempted address is kept so an operator can spot credential
      // stuffing; the password never is.
      await audit(db, user?.id ?? null, 'auth.login_failed', user ? `user:${user.id}` : null, {
        email: body.email,
        knownAccount: Boolean(user),
      }, clientIp(request));
      throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
    }
    if (user.disabled) {
      throw new ApiError(403, 'account_disabled', user.disabled_reason || 'This account is disabled');
    }
    limiter.clearFailures(failKey);

    if (await isMfaEnabled(db, user.id)) {
      if (body.mfaSupported === false) {
        throw new ApiError(
          400,
          'mfa_client_unsupported',
          'This account uses two-factor authentication. Update your Ravelon client to sign in',
        );
      }
      if (limiter.isLockedOut(mfaUserFailKey(user.id))) {
        throw new ApiError(429, 'too_many_attempts', 'Too many failed codes. Try again later');
      }
      const challenge = await issueMfaChallenge(
        db,
        user.id,
        body.deviceName ?? 'Ravelon Web',
        body.platform ?? 'web',
      );
      await audit(db, user.id, 'auth.mfa_challenge', `user:${user.id}`, null, clientIp(request));
      return reply.code(202).send(challenge);
    }

    await audit(db, user.id, 'auth.login', `user:${user.id}`, { mfa: false }, clientIp(request));
    return await issueSession(
      db,
      config,
      user.id,
      body.deviceName ?? 'Ravelon Web',
      body.platform ?? 'web',
      { ip: clientIp(request) },
    );
  });

  app.post('/v1/auth/mfa/verify', async (request) => {
    limiter.hit(`auth-mfa:${clientIp(request)}`, config.rateLimit.authPerIpPerMin);
    const body = z.object({
      challengeToken: z.string().min(24).max(200),
      code: mfaCodeSchema,
    }).parse(request.body);

    const challengeKey = `mfa-challenge:${sha256(body.challengeToken)}`;
    if (limiter.isLockedOut(challengeKey)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed codes. Start a new sign-in');
    }
    // Read up front so a wrong code counts against the account as well as the
    // challenge. Counting per challenge alone would let an attacker who has
    // the password start a fresh challenge every few guesses and never stop.
    const challengeOwner = await db.prepare('SELECT user_id FROM mfa_challenges WHERE challenge_hash = ?')
      .get<{ user_id: string }>(sha256(body.challengeToken));
    if (challengeOwner && limiter.isLockedOut(mfaUserFailKey(challengeOwner.user_id))) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed codes. Try again later');
    }

    let completed: Awaited<ReturnType<typeof completeMfaChallenge>>;
    try {
      completed = await completeMfaChallenge(db, config, body.challengeToken, body.code);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_mfa_code') {
        limiter.recordFailure(challengeKey);
        if (challengeOwner) {
          limiter.recordFailure(mfaUserFailKey(challengeOwner.user_id));
          await audit(db, challengeOwner.user_id, 'auth.mfa_failed', `user:${challengeOwner.user_id}`, {
            stage: 'sign_in',
          }, clientIp(request));
        }
      }
      throw error;
    }
    limiter.clearFailures(challengeKey);
    limiter.clearFailures(mfaUserFailKey(completed.challenge.user_id));

    await audit(db, completed.challenge.user_id, 'auth.login', `user:${completed.challenge.user_id}`, {
      mfa: true,
      factor: completed.factor,
    }, clientIp(request));

    return await issueSession(
      db,
      config,
      completed.challenge.user_id,
      completed.challenge.device_name,
      completed.challenge.platform,
      { mfaVerified: true, ip: clientIp(request) },
    );
  });

  app.post('/v1/auth/refresh', async (request) => {
    const body = z.object({ refreshToken: z.string().min(20).max(400) }).parse(request.body ?? {});
    return await rotateRefreshToken(db, config, body.refreshToken, { ip: clientIp(request) });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const body = z.object({ refreshToken: z.string().min(20).max(400).optional() })
      .parse(request.body ?? {});
    if (body.refreshToken) await revokeSessionByRefreshToken(db, body.refreshToken);
    return reply.code(204).send();
  });

  app.post('/v1/auth/password/change', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`password-change:${auth.user.id}`, 10);
    const body = z.object({
      currentPassword: z.string().min(1).max(512),
      newPassword: passwordSchema,
      mfaCode: mfaCodeSchema.optional(),
    }).parse(request.body);

    // Shares the reauthentication lockout, so a stolen session cannot guess
    // the current password here without limit. A second factor is checked
    // when sent but not yet required: the desktop and iOS clients call this
    // without one, and requiring it would lock them out of changing a
    // password at all.
    await verifyReauth(context, auth.user.id, auth.user.password_hash, {
      password: body.currentPassword,
      mfaCode: body.mfaCode,
    }, { wrongPasswordStatus: 400, ip: clientIp(request) });

    await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(await hashPassword(body.newPassword), nowIso(), auth.user.id);
    // A reset link requested before the change must not be able to undo it.
    await invalidatePasswordResetTokens(db, auth.user.id);
    // Every other device is signed out: a password change is how someone
    // responds to a suspected compromise, and it has to actually end sessions.
    await revokeAllSessions(db, auth.user.id, auth.deviceId);
    await audit(db, auth.user.id, 'auth.password_change', `user:${auth.user.id}`, null, clientIp(request));
    return reply.code(204).send();
  });

  app.post('/v1/auth/password/reset/request', async (request) => {
    limiter.hit(`reset:${clientIp(request)}`, config.rateLimit.authPerIpPerMin);
    const body = z.object({ email: emailSchema }).parse(request.body);
    const user = await getUserByEmail(db, body.email);

    if (user && !user.disabled) {
      const token = randomToken('prt');
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
      await db.prepare(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      ).run(newId(), user.id, sha256(token), expiresAt, nowIso());

      const platform = await readSetting(db, 'platform');
      const resetUrl = `${publicOrigin(config, request)}/reset-password?token=${encodeURIComponent(token)}`;
      const ip = clientIp(request);
      // Not awaited. An SMTP round trip only happens for a real account, so
      // waiting for it would make the response time reveal which addresses
      // exist here.
      void (async () => {
        const delivery = await sendMail(db, config, passwordResetEmail({
          serverName: platform.serverName,
          to: user.email,
          resetUrl,
          expiresAt,
        }));
        await audit(db, user.id, 'auth.password_reset_request', `user:${user.id}`, {
          delivered: delivery.sent,
        }, ip);
      })().catch((error: unknown) => {
        // Only the error class and code: the message could quote the mail,
        // and the mail carries the reset token.
        request.log.warn({
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: (error as { code?: unknown } | null)?.code ?? null,
        }, 'password reset mail failed');
      });
    }

    // The same answer either way, so this endpoint cannot be used to find out
    // which addresses have an account on this server.
    return { requested: true };
  });

  app.post('/v1/auth/password/reset/confirm', async (request, reply) => {
    limiter.hit(`reset-confirm:${clientIp(request)}`, config.rateLimit.authPerIpPerMin);
    const body = z.object({
      token: z.string().min(20).max(400),
      newPassword: passwordSchema,
    }).parse(request.body);

    const tokenHash = sha256(body.token);
    const userId = await db.transaction(async () => {
      const row = await db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?')
        .get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(tokenHash);
      if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
        throw new ApiError(400, 'invalid_reset_token', 'This reset link is invalid or expired');
      }
      const claimed = await db.prepare(
        'UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL',
      ).run(nowIso(), row.id);
      if (claimed.changes !== 1) {
        throw new ApiError(400, 'invalid_reset_token', 'This reset link is invalid or expired');
      }
      await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(await hashPassword(body.newPassword), nowIso(), row.user_id);
      // Any other link sent before this reset is spent too, so an older mail
      // found later cannot set the password again.
      await invalidatePasswordResetTokens(db, row.user_id);
      return row.user_id;
    })();

    await revokeAllSessions(db, userId);
    await audit(db, userId, 'auth.password_reset', `user:${userId}`, null, clientIp(request));
    return reply.code(204).send();
  });

  app.post('/v1/auth/verify-email/request', async (request) => {
    const auth = await requireAuth(db, config, request);
    limiter.hit(`verify:${auth.user.id}`, 5);
    if (auth.user.email_verified) return { requested: false, alreadyVerified: true };
    const delivery = await requestEmailVerification(context, request, auth.user.id, auth.user.email);
    return { requested: true, delivered: delivery.sent };
  });

  app.post('/v1/auth/verify-email/confirm', async (request) => {
    const body = z.object({ token: z.string().min(20).max(400) }).parse(request.body);
    const tokenHash = sha256(body.token);
    const userId = await db.transaction(async () => {
      const row = await db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?')
        .get<{ id: string; user_id: string; email: string; expires_at: string; used_at: string | null }>(tokenHash);
      if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
        throw new ApiError(400, 'invalid_verification_token', 'This confirmation link is invalid or expired');
      }
      const user = await getUserById(db, row.user_id);
      // The address may have changed since the link was sent; confirming an
      // address the account no longer uses would verify the wrong thing.
      if (!user || user.email !== row.email) {
        throw new ApiError(400, 'invalid_verification_token', 'This confirmation link is invalid or expired');
      }
      await db.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
      await db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?')
        .run(nowIso(), row.user_id);
      return row.user_id;
    })();
    await audit(db, userId, 'auth.email_verified', `user:${userId}`, null, clientIp(request));
    return { verified: true };
  });
}

/** Marks every unused reset link for an account as spent. */
export async function invalidatePasswordResetTokens(db: AppDatabase, userId: string): Promise<void> {
  await db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .run(nowIso(), userId);
}

/**
 * A scrypt hash of a value nobody knows.
 *
 * Verifying against it for an unknown email costs the same as a real check, so
 * a timing difference does not reveal which addresses have accounts here.
 */
const DUMMY_HASH = 'scrypt:32768$8$1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function requestEmailVerification(
  context: RouteContext,
  request: Parameters<typeof clientIp>[0],
  userId: string,
  email: string,
): Promise<{ sent: boolean; reason?: string }> {
  const { db, config } = context;
  const token = randomToken('evt');
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString();
  await db.prepare(
    `INSERT INTO email_verifications (id, user_id, token_hash, email, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(newId(), userId, sha256(token), email, expiresAt, nowIso());

  const platform = await readSetting(db, 'platform');
  const verifyUrl = `${publicOrigin(config, request)}/verify-email?token=${encodeURIComponent(token)}`;
  return await sendMail(db, config, emailVerificationEmail({
    serverName: platform.serverName,
    to: email,
    verifyUrl,
    expiresAt,
  }));
}

/**
 * Decides whether this email may create an account here, and consumes nothing.
 *
 * Returns the invitation that permits it, when one was used, so the caller can
 * mark it spent inside the same transaction that creates the account.
 */
export async function checkRegistrationAllowed(
  context: RouteContext,
  email: string,
  inviteToken: string | undefined,
): Promise<AccountInviteRow | null> {
  const { db } = context;
  const platform = await readSetting(db, 'platform');

  // A deployment with no accounts must let the first one in, or there would be
  // nobody able to configure the rest.
  if (await scalar(db, 'SELECT COUNT(*) AS count FROM users') === 0) return null;

  if (inviteToken) {
    const invite = await findUsableInvite(context, inviteToken);
    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
      throw new ApiError(403, 'invite_invalid', 'This invitation is not valid for that email address');
    }
    return invite;
  }

  if (platform.registrationMode === 'open') return null;
  if (platform.registrationMode === 'closed') {
    throw new ApiError(403, 'registration_closed', 'This server is not accepting new accounts');
  }
  if (platform.registrationMode === 'invite') {
    throw new ApiError(403, 'invite_required', 'An invitation is required to create an account here');
  }

  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!platform.allowedEmailDomains.includes(domain)) {
    throw new ApiError(
      403,
      'email_domain_not_allowed',
      'Accounts on this server are limited to approved email domains',
    );
  }
  return null;
}

export async function findUsableInvite(
  context: RouteContext,
  token: string,
): Promise<AccountInviteRow> {
  const invite = await context.db.prepare('SELECT * FROM account_invites WHERE token_hash = ?')
    .get<AccountInviteRow>(sha256(token));
  if (
    !invite
    || invite.used_at
    || invite.revoked_at
    || Date.parse(invite.expires_at) <= Date.now()
  ) {
    throw new ApiError(403, 'invite_invalid', 'This invitation is invalid, used or expired');
  }
  return invite;
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    emailVerified: Boolean(user.email_verified),
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastSeenAt: user.last_seen_at,
  };
}
