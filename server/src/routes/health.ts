import type { FastifyInstance } from 'fastify';

import { scalar } from '../db/database.js';
import { readSetting } from '../lib/settings.js';
import { emailVerificationRequired, type RouteContext } from './context.js';

/**
 * Endpoints a Ravelon client and a container orchestrator both need.
 *
 * `/v1/health` is what the desktop client calls before it will talk to a
 * server it has not seen before. It reports `officialBuild: false`, which
 * tells the client this is a community deployment and there is no licence to
 * check. Answering it is what makes a server addable in the app at all.
 */
export function registerHealthRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config } = context;

  app.get('/v1/health', async () => {
    const platform = await readSetting(db, 'platform');
    return {
      status: 'ok',
      service: 'ravelon-sync',
      version: config.version,
      // A self-hosted build is never the hosted service, so no licence applies.
      officialBuild: false,
      licenseStatus: 'self-hosted',
      serverName: platform.serverName,
      registrationMode: platform.registrationMode,
      maintenanceMode: platform.maintenanceMode,
      capabilities: [
        'granularSync',
        'syncEvents',
        'vaultWatch',
        'teams',
        'mfa',
        'devicePairing',
        'legacySnapshots',
      ],
    };
  });

  // Liveness for Docker and Kubernetes: cheap, unauthenticated, and it touches
  // the database so a healthy answer means the process can actually serve.
  app.get('/healthz', async (_request, reply) => {
    try {
      await scalar(db, 'SELECT 1 AS ok');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded' });
    }
  });

  /**
   * Everything the web interface needs before anyone signs in: whether this
   * deployment has been set up yet, and whether the sign-up form should exist.
   */
  app.get('/v1/public-config', async () => {
    const platform = await readSetting(db, 'platform');
    const accounts = await scalar(db, 'SELECT COUNT(*) AS count FROM users');
    return {
      serverName: platform.serverName,
      version: config.version,
      /** No accounts yet: the web interface shows first-run setup instead of sign-in. */
      needsSetup: accounts === 0,
      registrationMode: platform.registrationMode,
      registrationOpen: accounts === 0 || platform.registrationMode === 'open',
      /** `domain` mode still shows the form; the domain list is public so the error is honest. */
      allowedEmailDomains: platform.registrationMode === 'domain' ? platform.allowedEmailDomains : [],
      // The effective rule, not the raw switch: domain sign-up requires a
      // confirmed address whatever the switch says.
      requireEmailVerification: emailVerificationRequired(platform),
      maintenanceMode: platform.maintenanceMode,
      maintenanceMessage: platform.maintenanceMode ? platform.maintenanceMessage : '',
      passwordMinLength: 10,
    };
  });
}
