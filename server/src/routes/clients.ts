import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../auth/sessions.js';
import { pushRegistration } from '../lib/push-relay.js';
import { assertCanSync, type RouteContext } from './context.js';

/** Optional push relay registration; telemetry always remains disabled. */
export function registerClientRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config } = context;

  app.post('/v1/push/devices', async (request) => {
    const auth = await requireAuth(db, config, request);
    if (!context.pushRelay) {
      // Preserve the pre-relay compatibility response without retaining a token.
      z.object({
        token: z.string().min(1).max(512),
        platform: z.string().min(1).max(40),
        environment: z.string().min(1).max(40),
        topic: z.string().min(1).max(200),
        agentAlerts: z.boolean().optional(),
      }).parse(request.body);
      return { registered: false };
    }
    await assertCanSync(context, Boolean(auth.user.email_verified));
    const input = pushRegistration.parse(request.body);
    await context.pushRelay.register(auth.user.id, auth.deviceId, input, () =>
      requireAuth(db, config, request),
    );
    return { registered: true };
  });
  app.delete('/v1/push/devices', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await context.pushRelay?.remove(auth.user.id, auth.deviceId);
    return reply.code(204).send();
  });

  /** This server collects no usage counters from any client. */
  app.get('/v1/telemetry/:platform/config', async (request) => {
    z.object({ platform: z.enum(['ios', 'desktop', 'android']) }).parse(request.params);
    return { enabled: false };
  });

  /**
   * Erasure requests succeed, truthfully: nothing was ever stored under any
   * install id, so there is nothing left to keep. Clients hold the id until a
   * server confirms, and without this they would ask forever.
   */
  app.post('/v1/telemetry/:platform/forget', async (request) => {
    z.object({ platform: z.enum(['ios', 'desktop', 'android']) }).parse(request.params);
    z.object({ installId: z.string().min(1).max(200) }).parse(request.body);
    return { forgotten: true };
  });
}
