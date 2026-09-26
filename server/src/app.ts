import { existsSync } from 'node:fs';
import path from 'node:path';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Config } from './config.js';
import { type AppDatabase, openDatabase } from './db/database.js';
import { verifyAccessToken } from './lib/crypto.js';
import { ApiError } from './lib/errors.js';
import { RateLimiter } from './lib/rate-limit.js';
import { SyncEventHub } from './lib/sync-events.js';
import { SYNC_BODY_LIMIT_BYTES } from './routes/sync.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerClientRoutes } from './routes/clients.js';
import { registerAuthRoutes } from './routes/auth.js';
import type { RouteContext } from './routes/context.js';
import { registerDesktopRoutes } from './routes/desktop.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerVaultRoutes } from './routes/vaults.js';

/**
 * Sent with every response, API and interface alike.
 *
 * The built interface loads only same-origin module scripts, stylesheets and
 * fonts, with no inline script or style element, so the policy allows
 * nothing else beyond data: images and fonts. That turns an injected script into a refused load rather
 * than code running with a signed-in session's tokens.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  // Vite inlines the smallest font subsets into the stylesheet as data: URIs.
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
};

/** Everything except the sync push, which sets its own much larger limit. */
const GENERAL_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export interface BuiltServer {
  app: FastifyInstance;
  db: AppDatabase;
  syncEvents: SyncEventHub;
}

export async function buildServer(config: Config, db?: AppDatabase): Promise<BuiltServer> {
  const database = db ?? await openDatabase({
    databaseUrl: config.databaseUrl,
    databaseFile: config.databaseFile,
  });

  const app = Fastify({
    // Only exact proxy addresses are trusted. Trusting every hop would let any
    // client set X-Forwarded-For and defeat the per-IP rate limits.
    trustProxy: config.trustedProxyIps.length > 0 ? config.trustedProxyIps : false,
    bodyLimit: GENERAL_BODY_LIMIT_BYTES,
    logger: config.nodeEnv === 'test'
      ? false
      : {
        level: config.nodeEnv === 'production' ? 'info' : 'debug',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.newPassword',
            'req.body.currentPassword',
            'req.body.refreshToken',
            'req.body.token',
            'req.body.code',
            'req.body.mfaCode',
          ],
          censor: '[redacted]',
        },
      },
  });

  const context: RouteContext = {
    db: database,
    config,
    limiter: new RateLimiter(config),
    syncEvents: new SyncEventHub(),
  };

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  // The bundled web interface is same-origin, so it needs no entry here. CORS
  // exists only for a deployment that serves the interface from elsewhere.
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  // One general budget per account for everything authenticated. Sync push
  // and pull count against their own, larger limit and the desktop vault
  // routes are polled continuously by design, so they are left out here
  // rather than being counted twice. Only the token's signature is checked:
  // the route itself still runs the full requireAuth, and an invalid token
  // is refused there.
  app.addHook('onRequest', async (request) => {
    if (!config.rateLimit.enabled) return;
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/v1/')) return;
    if (path.startsWith('/v1/sync/') || path.startsWith('/v1/desktop/vault')) return;
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return;
    const claims = verifyAccessToken(config.jwtSecret, header.slice(7).trim());
    if (!claims) return;
    context.limiter.hit(`api:${claims.sub}`, config.rateLimit.apiPerUserPerMin);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] ?? '';
    // No API response is ever a shared cache's business, and several carry
    // tokens that must not be stored by an intermediary. Static files keep
    // what the static handler chose, so hashed assets stay cacheable instead
    // of being fetched again on every page load.
    if (path.startsWith('/v1/') || path.startsWith('/healthz') || !reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    // HSTS only over HTTPS: sent over plain HTTP it is ignored at best, and a
    // development server on http://localhost must not be pinned to HTTPS.
    // request.protocol only reflects X-Forwarded-Proto from a trusted proxy.
    if (request.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join(', '),
        },
      });
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'payload_too_large', message: 'Request body is too large' },
      });
    }
    // Anything unrecognised is a bug. It is logged in full and answered with a
    // generic message, so an internal detail never reaches a client.
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on the server' },
    });
  });

  registerHealthRoutes(app, context);
  registerAuthRoutes(app, context);
  registerAccountRoutes(app, context);
  registerVaultRoutes(app, context);
  registerTeamRoutes(app, context);
  registerSyncRoutes(app, context);
  registerDesktopRoutes(app, context);
  registerAdminRoutes(app, context);
  registerClientRoutes(app, context);

  await registerWebInterface(app, config);

  return { app, db: database, syncEvents: context.syncEvents };
}

/**
 * Serves the built web interface from the same origin as the API.
 *
 * One origin means no CORS to configure, no second container, and no API URL
 * baked in at build time. A deployment that would rather serve the interface
 * separately sets WEB_ROOT to an empty string and gets an API-only server.
 */
async function registerWebInterface(app: FastifyInstance, config: Config): Promise<void> {
  const available = Boolean(config.webRoot) && existsSync(path.join(config.webRoot, 'index.html'));
  if (config.webRoot && !available) {
    app.log.warn(
      { webRoot: config.webRoot },
      'No built web interface found. Serving the API only. Run `npm run build` in web/.',
    );
  }

  if (available) {
    await app.register(fastifyStatic, {
      root: config.webRoot,
      // Hashed asset filenames may be cached forever; index.html must not be,
      // or a deploy leaves browsers on the previous build.
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith('.html')) {
          reply.header('Cache-Control', 'no-cache');
          return;
        }
        if (/[\\/]assets[\\/]/.test(filePath)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }
        // Unhashed files such as the favicon keep their name across deploys.
        reply.header('Cache-Control', 'no-cache');
      },
    });
  }

  // Registered whether or not the interface is bundled, so an API-only
  // deployment answers an unknown path in the same `{ error: { code } }`
  // shape as every other failure. Ravelon clients parse that shape.
  app.setNotFoundHandler((request, reply) => {
    const wantsPage = available
      && (request.method === 'GET' || request.method === 'HEAD')
      && !request.url.startsWith('/v1/')
      && !request.url.startsWith('/healthz');
    if (!wantsPage) {
      return reply.code(404).send({
        error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
      });
    }
    // Browser navigation falls through to the single-page app, which resolves
    // the route itself.
    reply.header('Cache-Control', 'no-cache');
    return reply.type('text/html').sendFile('index.html');
  });
}

export { SYNC_BODY_LIMIT_BYTES };
