import { audit } from '../lib/audit.js';
import { verifyPassword } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { RouteContext } from '../routes/context.js';
import { isMfaEnabled, verifySecondFactor } from './mfa.js';

export interface ReauthProof {
  password: string;
  mfaCode?: string;
}

export interface ReauthOptions {
  /** Refuse without a valid second factor when the account has one enrolled. */
  requireMfa?: boolean;
  /**
   * Status for a wrong password. Account routes answer 401, which the clients
   * that call them already expect. Password change answers 400, because the
   * iOS client reads any 401 as an expired access token and would spend its
   * refresh token on a typo.
   */
  wrongPasswordStatus?: 400 | 401;
  ip?: string | null;
}

/** The key every password and code check for one account counts against. */
export function reauthFailKey(userId: string): string {
  return `reauth:${userId}`;
}

/** The per-account second-factor lockout shared by sign-in and reauthentication. */
export function mfaUserFailKey(userId: string): string {
  return `mfa-user:${userId}`;
}

/**
 * Re-checks the password, and the second factor when one is enrolled.
 *
 * All sensitive account changes share one failure counter per account, so an
 * attacker holding a stolen session cannot spread password guesses across
 * several endpoints to stay under the lockout.
 */
export async function verifyReauth(
  context: RouteContext,
  userId: string,
  passwordHash: string,
  proof: ReauthProof,
  options: ReauthOptions = {},
): Promise<void> {
  const failKey = reauthFailKey(userId);
  if (context.limiter.isLockedOut(failKey)) {
    throw new ApiError(429, 'too_many_attempts', 'Too many failed attempts. Try again later');
  }
  if (!(await verifyPassword(proof.password, passwordHash))) {
    context.limiter.recordFailure(failKey);
    throw new ApiError(options.wrongPasswordStatus ?? 401, 'invalid_credentials', 'Password is incorrect');
  }

  const mfaEnabled = await isMfaEnabled(context.db, userId);
  if (mfaEnabled && (options.requireMfa || proof.mfaCode)) {
    if (!proof.mfaCode) {
      throw new ApiError(400, 'mfa_code_required', 'Enter a code from your authenticator');
    }
    if (context.limiter.isLockedOut(mfaUserFailKey(userId))) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed codes. Try again later');
    }
    const factor = await verifySecondFactor(context.db, context.config, userId, proof.mfaCode);
    if (!factor) {
      context.limiter.recordFailure(failKey);
      context.limiter.recordFailure(mfaUserFailKey(userId));
      await audit(
        context.db,
        userId,
        'auth.mfa_failed',
        `user:${userId}`,
        { stage: 'reauth' },
        options.ip ?? null,
      );
      throw new ApiError(400, 'invalid_mfa_code', 'That code is not valid');
    }
  }
  // Cleared only once every requested factor passed, so a right password
  // followed by wrong codes still runs into the lockout.
  context.limiter.clearFailures(failKey);
}
