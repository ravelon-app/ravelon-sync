import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ApiError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import type { SyncEventHub } from '../lib/sync-events.js';
import { readSetting } from '../lib/settings.js';

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
 * PUBLIC_URL wins when set. Otherwise the request's own origin is used, which
 * is right for the common single-origin deployment and keeps a fresh install
 * working before anything is configured.
 */
export function publicOrigin(config: Config, request: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const protocol = forwardedProto || request.protocol;
  const host = forwardedHost || request.headers.host;
  return host ? `${protocol}://${host}` : '';
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.split(',')[0]?.trim() ?? '';
  return value?.split(',')[0]?.trim() ?? '';
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
 * Gate for every sync and vault endpoint.
 *
 * A self-hosted deployment has no subscription to check, so the only condition
 * is whether the operator requires a verified email address.
 */
export async function assertCanSync(context: RouteContext, userEmailVerified: boolean): Promise<void> {
  const platform = await readSetting(context.db, 'platform');
  if (platform.requireEmailVerification && !userEmailVerified) {
    throw new ApiError(
      403,
      'email_verification_required',
      'Confirm your email address before syncing',
    );
  }
}
