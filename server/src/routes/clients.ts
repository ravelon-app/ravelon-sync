import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../auth/sessions.js';
import type { RouteContext } from './context.js';

/**
 * Answers for client features that exist only on the hosted service.
 *
 * Ravelon clients talk to whichever server the account is signed in to, so a
 * self-hosted deployment is asked about push notifications and usage counters
 * too. A 404 there reads to a client as a broken server; these routes give the
 * honest answer instead: nothing is collected and no push is sent.
 */
export function registerClientRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config } = context;

  /**
   * APNs registration from the iOS app.
   *
   * Sending a push needs the publisher's Apple signing key, which a
   * self-hosted deployment does not have. The device token is therefore not
   * stored; the client keeps its WebSocket and background refresh instead.
   */
  app.post('/v1/push/devices', async (request) => {
    await requireAuth(db, config, request);
    z.object({
      token: z.string().min(1).max(512),
      platform: z.string().min(1).max(40),
      environment: z.string().min(1).max(40),
      topic: z.string().min(1).max(200),
    }).parse(request.body);
    return { registered: false };
  });

  /** This server collects no usage counters from any client. */
  app.get('/v1/telemetry/:platform/config', async (request) => {
    z.object({ platform: z.enum(['ios', 'desktop']) }).parse(request.params);
    return { enabled: false };
  });

  /**
   * Erasure requests succeed, truthfully: nothing was ever stored under any
   * install id, so there is nothing left to keep. Clients hold the id until a
   * server confirms, and without this they would ask forever.
   */
  app.post('/v1/telemetry/:platform/forget', async (request) => {
    z.object({ platform: z.enum(['ios', 'desktop']) }).parse(request.params);
    z.object({ installId: z.string().min(1).max(200) }).parse(request.body);
    return { forgotten: true };
  });
}
