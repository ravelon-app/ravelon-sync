import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ApiError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import type { SyncEventHub } from '../lib/sync-events.js';
import { type PlatformSettings, readSetting } from '../lib/settings.js';

export interface RouteContext {
  db: AppDatabase;
  config: Config;
  limiter: RateLimiter;
  syncEvents: SyncEventHub;
}

export function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

/**
 * The origin to put into a link a person will click.
 *
 * PUBLIC_URL wins, and production refuses to start without it. Outside
 * production the origin comes from Fastify's `protocol` and `host`, which only
 * read X-Forwarded-Proto and X-Forwarded-Host from a peer in
 * TRUSTED_PROXY_IPS. Reading those headers directly would let anyone point a
 * password-reset link at a host of their choosing.
 */
export function publicOrigin(config: Config, request: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const host = request.host;
  return host ? `${request.protocol}://${host}` : '';
}

export const emailSchema = z.string().trim().max(254).toLowerCase().pipe(z.email());

/**
 * Minimum password length.
 *
 * The Ravelon desktop client refuses anything under 10 characters before it
 * even calls the server, so a lower bound here would only be reachable from
 * the web interface and would create an inconsistency between clients.
 */
export const PASSWORD_MIN = 10;
export const passwordSchema = z.string().min(PASSWORD_MIN).max(512);

export const displayNameSchema = z.string().trim().min(1).max(80);
export const vaultNameSchema = z.string().trim().min(1).max(80);
export const deviceNameSchema = z.string().trim().min(1).max(120);
export const platformSchema = z.string().trim().min(1).max(40);
export const mfaCodeSchema = z.string().trim().min(6).max(32);

export function idParam(request: FastifyRequest): string {
  return z.object({ id: z.string().min(1).max(160) }).parse(request.params).id;
}

/**
 * Refuses writes while the deployment is in maintenance.
 *
 * Reads and sign-in stay up on purpose, so a person reaching the server sees
 * the notice instead of a blank failure.
 */
export async function assertNotInMaintenance(context: RouteContext): Promise<void> {
  const platform = await readSetting(context.db, 'platform');
  if (!platform.maintenanceMode) return;
  throw new ApiError(
    503,
    'maintenance_mode',
    platform.maintenanceMessage || 'This server is in maintenance mode. Try again shortly',
  );
}

/**
 * Whether this deployment needs a confirmed address before an account syncs.
 *
 * `domain` sign-up admits anyone who types an address at an allowed domain.
 * Without proof they can read mail there, anyone could register
 * someone@corp.example and sync as a colleague, so that mode always requires
 * the address to be confirmed.
 */
export function emailVerificationRequired(platform: PlatformSettings): boolean {
  return platform.requireEmailVerification || platform.registrationMode === 'domain';
}

/**
 * Gate for every sync and vault endpoint.
 *
 * A self-hosted deployment has no subscription to check, so the only condition
 * is whether a verified email address is required.
 */
export async function assertCanSync(context: RouteContext, userEmailVerified: boolean): Promise<void> {
  const platform = await readSetting(context.db, 'platform');
  if (emailVerificationRequired(platform) && !userEmailVerified) {
    throw new ApiError(403, 'email_verification_required', 'Confirm your email address before syncing');
  }
}
