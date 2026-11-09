import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../auth/sessions.js';
import { newId, nowIso } from '../config.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import {
  assertCanSync,
  assertNotInMaintenance,
  clientIp,
  publicOrigin,
  type RouteContext,
} from './context.js';

/**
 * Public links: a sealed copy of an artifact or agent thread that the
 * Ravelon desktop app shares with anyone who has the link.
 *
 * The server stores ciphertext it cannot read. The desktop seals the page
 * with a new AES-256-GCM key per link and puts the key in the link's
 * `#fragment`, which browsers never send. `/p/<id>` is a small page that
 * fetches the sealed bytes, opens them in the browser with that key and
 * shows the result in a sandboxed frame that runs no script. The server
 * keeps who owns a link, its size and its expiry, and nothing else.
 */

/** Days a link may stay up; the desktop offers the same three. */
const EXPIRY_DAYS = [1, 7, 30] as const;
/** Sealed bytes per link: the desktop's 2 MB page plus its JSON wrapping and the cipher's overhead. */
export const MAX_SEALED_BYTES = 3 * 1024 * 1024;
/** Links one account may have up at once. */
export const MAX_LINKS_PER_USER = 50;
/** Opening links, per IP and minute. */
const VIEWS_PER_IP_PER_MIN = 120;
/** Nonce and tag of AES-GCM: nothing shorter is a sealed page. */
const MIN_SEALED_BYTES = 12 + 16 + 1;

const publicIdPattern = /^[A-Za-z0-9_-]{22}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

const createSchema = z
  .object({
    sealed: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_SEALED_BYTES / 3) * 4),
    expiresInDays: z.literal(EXPIRY_DAYS),
  })
  .strict();

interface LinkRow {
  id: string;
  public_id: string;
  created_at: string;
  expires_at: string;
}

/**
 * The sealed bytes, or a refusal. Valid UTF-8 is refused: AES-GCM output of
 * this size is never valid UTF-8 by chance, so such a body is a page sent in
 * the clear, which this server does not store.
 */
function sealedBytes(sealed: string): Buffer {
  const bytes = base64Pattern.test(sealed) ? Buffer.from(sealed, 'base64') : Buffer.alloc(0);
  if (bytes.length < MIN_SEALED_BYTES || bytes.length > MAX_SEALED_BYTES) {
    throw new ApiError(400, 'invalid_link', 'The link content is not a sealed page');
  }
  if (isUtf8(bytes)) {
    throw new ApiError(400, 'plaintext_refused', 'The link content must be encrypted');
  }
  return bytes;
}

function linkView(origin: string, row: LinkRow) {
  return {
    id: row.id,
    url: `${origin}/p/${row.public_id}`,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function notFound(): ApiError {
  return new ApiError(404, 'link_not_found', 'This link has expired or was removed');
}

/**
 * The page at `/p/<id>`. It holds no data: the script reads the id from the
 * path and the key from the fragment. Plain text is replaced by the script
 * before anything else is shown.
 */
const VIEWER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Shared page</title>
<style>
html,body{margin:0;height:100%;background:#fff;color:#1d1f23;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){html,body{background:#121417;color:#e6e8eb}}
#status{max-width:520px;margin:20vh auto 0;padding:0 20px;text-align:center}
iframe{display:block;width:100%;height:100%;border:0}
</style>
<script type="module" src="/p/viewer.js"></script>
</head>
<body><p id="status">Loading…</p></body>
</html>
`;

/**
 * Opens the sealed page. The frame has an empty sandbox: no script, no form,
 * no popup, an opaque origin. Its document also inherits this page's policy,
 * which allows no request except data: images and inline styles.
 */
const VIEWER_SCRIPT = `const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const fromBase64Url = (text) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
async function open() {
  const id = location.pathname.split('/')[2] || '';
  const key = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
    say('This link is incomplete. Copy the whole link and try again.');
    return;
  }
  const response = await fetch('/v1/public-links/content/' + id, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (response.status === 404) {
    say('This link has expired or was removed.');
    return;
  }
  if (!response.ok) {
    say('This page could not be loaded. Try again later.');
    return;
  }
  const { sealed } = await response.json();
  const bytes = fromBase64(sealed);
  const cryptoKey = await crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['decrypt']);
  let page;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode('ravelon-public-link-v1') },
      cryptoKey,
      bytes.slice(12),
    );
    page = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    say('This link is incomplete. Copy the whole link and try again.');
    return;
  }
  if (!page || page.v !== 1 || typeof page.html !== 'string') {
    say('This page could not be loaded. Try again later.');
    return;
  }
  if (typeof page.title === 'string' && page.title) document.title = page.title;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = document.title;
  frame.srcdoc = page.html;
  status.replaceWith(frame);
}
open().catch(() => say('This page could not be loaded. Try again later.'));
`;

/**
 * Policy of `/p/` responses, in place of the interface's: the page's own
 * script, its request for the sealed bytes, inline styles and data: images.
 * Nothing else loads, in the page or in the frame, which inherits it.
 */
export const PUBLIC_LINK_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow');
}

export function registerPublicLinkRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, limiter } = context;

  app.post('/v1/public-links', { bodyLimit: MAX_SEALED_BYTES * 2 }, async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    const input = createSchema.parse(request.body);
    const bytes = sealedBytes(input.sealed);
    const now = new Date();
    const row: LinkRow = {
      id: newId(),
      public_id: randomBytes(16).toString('base64url'),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
    };
    await db.transaction(async () => {
      // Serialize the quota per account on PostgreSQL; SQLite transactions are already serialized.
      if (db.dialect === 'postgres')
        await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(auth.user.id);
      const active = await db
        .prepare('SELECT COUNT(*) AS n FROM public_links WHERE user_id = ? AND expires_at > ?')
        .get<{ n: number | string }>(auth.user.id, row.created_at);
      if (Number(active?.n ?? 0) >= MAX_LINKS_PER_USER) {
        throw new ApiError(
          409,
          'link_limit_reached',
          `You can have at most ${MAX_LINKS_PER_USER} public links. Revoke one first`,
        );
      }
      await db
        .prepare(
          'INSERT INTO public_links (id, user_id, public_id, sealed, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.id, auth.user.id, row.public_id, input.sealed, bytes.length, row.created_at, row.expires_at);
    })();
    await audit(
      db,
      auth.user.id,
      'public_link.create',
      row.id,
      { expiresInDays: input.expiresInDays },
      clientIp(request),
    );
    return reply.code(201).send(linkView(publicOrigin(config, request), row));
  });

  app.get('/v1/public-links', async (request) => {
    const auth = await requireAuth(db, config, request);
    const rows = await db
      .prepare(
        'SELECT id, public_id, created_at, expires_at FROM public_links WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
      )
      .all<LinkRow>(auth.user.id, nowIso());
    const origin = publicOrigin(config, request);
    return { links: rows.map((row) => linkView(origin, row)) };
  });

  app.delete('/v1/public-links/:id', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    const id = z.object({ id: z.uuid() }).parse(request.params).id;
    const deleted = await db
      .prepare('DELETE FROM public_links WHERE id = ? AND user_id = ?')
      .run(id, auth.user.id);
    if (!deleted.changes) throw new ApiError(404, 'link_not_found', 'Link not found or not accessible');
    await audit(db, auth.user.id, 'public_link.revoke', id, null, clientIp(request));
    return reply.code(204).send();
  });

  // Unauthenticated: anyone with the link reads the sealed bytes, never a key.
  app.get('/v1/public-links/content/:publicId', async (request) => {
    if (config.rateLimit.enabled) limiter.hit(`public-link:${clientIp(request)}`, VIEWS_PER_IP_PER_MIN);
    const { publicId } = z.object({ publicId: z.string().regex(publicIdPattern) }).parse(request.params);
    const row = await db
      .prepare('SELECT sealed, expires_at FROM public_links WHERE public_id = ? AND expires_at > ?')
      .get<{ sealed: string; expires_at: string }>(publicId, nowIso());
    if (!row) throw notFound();
    return { sealed: row.sealed, expiresAt: row.expires_at };
  });

  app.get('/p/viewer.js', async (_request, reply) =>
    reply.header('Cache-Control', 'no-cache').type('text/javascript; charset=utf-8').send(VIEWER_SCRIPT),
  );

  // The same page for every id, known or not: whether a link exists is told
  // only to the script, by the content request above.
  app.get('/p/:publicId', async (_request, reply) =>
    noStore(reply).type('text/html; charset=utf-8').send(VIEWER_PAGE),
  );
}

/** Expired links, for the daily cleanup. Reads check the expiry themselves. */
export async function deleteExpiredPublicLinks(db: RouteContext['db'], now: string): Promise<void> {
  await db.prepare('DELETE FROM public_links WHERE expires_at < ?').run(now);
}
