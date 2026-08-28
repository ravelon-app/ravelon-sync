import { createHmac } from 'node:crypto';

import { type Config, newId, nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { decryptSecret, encryptSecret, purposeKey, randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { MfaChallengeRow, UserMfaRow } from '../lib/rows.js';
import { generateRecoveryCodes, normalizeRecoveryCode, verifyTotp } from './totp.js';

const TOTP_PURPOSE = 'mfa:totp-secret';
const RECOVERY_PURPOSE = 'mfa:recovery-code';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresAt: string;
}

export async function getUserMfa(db: AppDatabase, userId: string): Promise<UserMfaRow | undefined> {
  return await db.prepare('SELECT * FROM user_mfa WHERE user_id = ?').get<UserMfaRow>(userId);
}

export async function isMfaEnabled(db: AppDatabase, userId: string): Promise<boolean> {
  const row = await getUserMfa(db, userId);
  return Boolean(row?.totp_secret_encrypted && row.totp_confirmed_at);
}

/** Stores an unconfirmed secret. It only becomes a second factor once a code proves the pairing. */
export async function startTotpEnrollment(
  db: AppDatabase,
  config: Config,
  userId: string,
  secret: string,
): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO user_mfa (user_id, totp_secret_encrypted, totp_confirmed_at, last_totp_step, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       totp_secret_encrypted = excluded.totp_secret_encrypted,
       totp_confirmed_at = NULL,
       last_totp_step = NULL,
       updated_at = excluded.updated_at`,
  ).run(userId, encryptSecret(config.mfaEncryptionKey, TOTP_PURPOSE, secret), now, now);
}

/**
 * Unwraps a stored authenticator secret.
 *
 * Returns null when it cannot be read, which in practice means
 * `MFA_ENCRYPTION_KEY` was rotated or restored from a different deployment.
 * That is a configuration problem, not a bad code, and the caller must say so
 * plainly rather than answering "wrong code" forever or crashing with a 500.
 */
export function decryptTotpSecret(config: Config, encrypted: string): string | null {
  try {
    return decryptSecret(config.mfaEncryptionKey, TOTP_PURPOSE, encrypted);
  } catch {
    return null;
  }
}

const MFA_SECRET_UNREADABLE = new ApiError(
  500,
  'mfa_secret_unreadable',
  'This server cannot read its stored authenticator secrets. '
  + 'MFA_ENCRYPTION_KEY does not match the one they were saved with. '
  + 'Restore the original key, or have an administrator reset two-factor for this account',
);

/**
 * Confirms enrolment and returns the recovery codes.
 *
 * The codes are shown exactly once. Only keyed hashes are stored, so a copy of
 * the database does not hand an attacker a way past the second factor.
 */
export async function confirmTotpEnrollment(
  db: AppDatabase,
  config: Config,
  userId: string,
  code: string,
): Promise<string[]> {
  const row = await getUserMfa(db, userId);
  if (!row?.totp_secret_encrypted) {
    throw new ApiError(400, 'mfa_not_started', 'Start authenticator setup first');
  }
  if (row.totp_confirmed_at) {
    throw new ApiError(409, 'mfa_already_enabled', 'An authenticator is already enrolled');
  }
  const secret = decryptTotpSecret(config, row.totp_secret_encrypted);
  if (secret === null) throw MFA_SECRET_UNREADABLE;
  const step = verifyTotp(secret, code, null);
  if (step === null) throw new ApiError(400, 'invalid_mfa_code', 'That code is not valid');

  const codes = generateRecoveryCodes();
  const now = nowIso();
  await db.transaction(async () => {
    await db.prepare(
      'UPDATE user_mfa SET totp_confirmed_at = ?, last_totp_step = ?, updated_at = ? WHERE user_id = ?',
    ).run(now, step, now, userId);
    await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
    for (const recoveryCode of codes) {
      await db.prepare(
        'INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
      ).run(newId(), userId, hashRecoveryCode(config, recoveryCode), now);
    }
  })();
  return codes;
}

export async function regenerateRecoveryCodes(
  db: AppDatabase,
  config: Config,
  userId: string,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const now = nowIso();
  await db.transaction(async () => {
    await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
    for (const code of codes) {
      await db.prepare(
        'INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
      ).run(newId(), userId, hashRecoveryCode(config, code), now);
    }
  })();
  return codes;
}

export async function disableMfa(db: AppDatabase, userId: string): Promise<void> {
  await db.transaction(async () => {
    await db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(userId);
    await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
    await db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(userId);
  })();
}

export async function countUnusedRecoveryCodes(db: AppDatabase, userId: string): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL',
  ).get<{ count: number }>(userId);
  return Number(row?.count ?? 0);
}

/**
 * Issues the short-lived token that stands in for a half-finished sign-in.
 *
 * The password was already correct at this point; the challenge only carries
 * the intent to finish, and expires quickly so an abandoned attempt cannot be
 * picked up later.
 */
export async function issueMfaChallenge(
  db: AppDatabase,
  userId: string,
  deviceName: string,
  platform: string,
): Promise<MfaChallenge> {
  await db.prepare('DELETE FROM mfa_challenges WHERE expires_at <= ? OR used_at IS NOT NULL')
    .run(nowIso());
  const challengeToken = randomToken('mch');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  await db.prepare(
    `INSERT INTO mfa_challenges (id, user_id, challenge_hash, device_name, platform, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(newId(), userId, sha256(challengeToken), deviceName, platform, expiresAt, nowIso());
  return { mfaRequired: true, challengeToken, expiresAt };
}

export interface CompletedChallenge {
  challenge: MfaChallengeRow;
  factor: 'totp' | 'recovery';
}

/**
 * Spends a challenge against a TOTP or recovery code.
 *
 * The challenge row is claimed with a conditional update, so two requests
 * racing the same challenge cannot both produce a session.
 */
export async function completeMfaChallenge(
  db: AppDatabase,
  config: Config,
  challengeToken: string,
  code: string,
): Promise<CompletedChallenge> {
  const challengeHash = sha256(challengeToken);
  const challenge = await db.prepare('SELECT * FROM mfa_challenges WHERE challenge_hash = ?')
    .get<MfaChallengeRow>(challengeHash);
  if (!challenge || challenge.used_at || Date.parse(challenge.expires_at) <= Date.now()) {
    throw new ApiError(400, 'invalid_mfa_challenge', 'This sign-in attempt expired. Start again');
  }

  const factor = await verifySecondFactor(db, config, challenge.user_id, code);
  if (!factor) throw new ApiError(400, 'invalid_mfa_code', 'That code is not valid');

  const claimed = await db.prepare(
    'UPDATE mfa_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL',
  ).run(nowIso(), challenge.id);
  if (claimed.changes !== 1) {
    throw new ApiError(400, 'invalid_mfa_challenge', 'This sign-in attempt expired. Start again');
  }
  return { challenge, factor };
}

/**
 * Checks one code against the account's authenticator, then its recovery codes.
 *
 * Returns which factor matched, or null. Both paths mark the code spent so it
 * cannot be replayed.
 */
export async function verifySecondFactor(
  db: AppDatabase,
  config: Config,
  userId: string,
  code: string,
): Promise<'totp' | 'recovery' | null> {
  const mfa = await getUserMfa(db, userId);
  if (!mfa?.totp_secret_encrypted || !mfa.totp_confirmed_at) return null;

  const secret = decryptTotpSecret(config, mfa.totp_secret_encrypted);
  // Fails closed: an unreadable secret must never fall through to the
  // recovery-code path, or a rotated key would silently downgrade the factor.
  if (secret === null) throw MFA_SECRET_UNREADABLE;

  const step = verifyTotp(secret, code, mfa.last_totp_step ?? null);
  if (step !== null) {
    // Conditional on the step still being the one we read, so two requests
    // with the same code cannot both be accepted.
    const claimed = await db.prepare(
      `UPDATE user_mfa SET last_totp_step = ?, updated_at = ?
       WHERE user_id = ? AND (last_totp_step IS NULL OR last_totp_step < ?)`,
    ).run(step, nowIso(), userId, step);
    return claimed.changes === 1 ? 'totp' : null;
  }

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 8) return null;
  const spent = await db.prepare(
    'UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
  ).run(nowIso(), userId, hashRecoveryCode(config, normalized));
  return spent.changes === 1 ? 'recovery' : null;
}

/**
 * Keyed digest of a recovery code.
 *
 * HMAC rather than a plain hash: a recovery code has far less entropy than a
 * password, so a stolen table must not be brute-forceable without also holding
 * MFA_ENCRYPTION_KEY.
 */
function hashRecoveryCode(config: Config, code: string): string {
  return createHmac('sha256', purposeKey(config.mfaEncryptionKey, RECOVERY_PURPOSE))
    .update(normalizeRecoveryCode(code), 'utf8')
    .digest('base64url');
}
