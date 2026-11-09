import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../auth/sessions.js';
import { newId, nowIso } from '../config.js';
import { audit } from '../lib/audit.js';
import {
  CHAT_PLATFORMS,
  type ChatPlatform,
  discordSignatureValid,
  postChatReply,
  slackSignatureValid,
} from '../lib/chat-platforms.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { assertCanSync, assertNotInMaintenance, clientIp, idParam, type RouteContext } from './context.js';

/**
 * Chat requests: someone types `/ravelon <request>` in Slack or Discord, and
 * it reaches the Ravelon desktop of an account that allowed that workspace,
 * channel and person. It never runs here or on its own: the desktop shows
 * it as a draft, and only the person at that computer starts an agent. A
 * reply goes back only when they send one, as text.
 *
 * Linking: the desktop asks for a one-time code; the person types
 * `/ravelon link <code>` in the chat app, which proves the chat identity
 * belongs to the account. The channel of that command and the person
 * become the first allowed ones; the desktop can allow more by id.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Requests waiting for one account; the oldest waiting ones make room. */
export const MAX_WAITING_PER_USER = 50;
const MAX_REQUEST_CHARS = 4000;
export const MAX_REPLY_CHARS = 3000;
/** A request may be answered this often. */
const MAX_REPLIES = 3;
const MAX_ALLOWED_PER_LINK = 100;
/** Platform requests per IP and minute, before their signature is checked. */
const PLATFORM_PER_IP_PER_MIN = 120;
/** Requests one workspace may send per minute. */
const REQUESTS_PER_WORKSPACE_PER_MIN = 60;

const platformSchema = z.enum(CHAT_PLATFORMS as [ChatPlatform, ...ChatPlatform[]]);
/** Slack (`T…`, `C…`, `U…`) and Discord (snowflake) ids. */
const chatId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const label = z.string().trim().max(120);

interface LinkRow {
  id: string;
  user_id: string;
  platform: ChatPlatform;
  workspace_id: string;
  workspace_label: string;
  member_id: string;
  member_label: string;
  created_at: string;
}

interface Incoming {
  platform: ChatPlatform;
  workspaceId: string;
  workspaceLabel: string;
  channelId: string;
  channelLabel: string;
  memberId: string;
  memberLabel: string;
  /** What followed `/ravelon`. */
  text: string;
}

function newCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A control character other than tab, line feed and carriage return. */
function unwantedControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
}

function clean(text: string, max: number): string {
  // Control characters other than line breaks and tabs never reach the desktop.
  let kept = '';
  for (const char of text) if (!unwantedControl(char.codePointAt(0) ?? 0)) kept += char;
  return kept.trim().slice(0, max);
}

export function registerChatRequestRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, limiter } = context;
  const enabled = (platform: ChatPlatform) => Boolean(config.chat[platform]);

  // --- Desktop ------------------------------------------------------------------

  app.get('/v1/chat', async (request) => {
    const auth = await requireAuth(db, config, request);
    const links = await db
      .prepare('SELECT * FROM chat_links WHERE user_id = ? ORDER BY created_at')
      .all<LinkRow>(auth.user.id);
    const allowed = await db
      .prepare(
        `SELECT a.id, a.link_id, a.kind, a.value, a.label FROM chat_allowed a
         JOIN chat_links l ON l.id = a.link_id WHERE l.user_id = ? ORDER BY a.created_at`,
      )
      .all<{ id: string; link_id: string; kind: string; value: string; label: string }>(auth.user.id);
    return {
      platforms: { slack: enabled('slack'), discord: enabled('discord') },
      links: links.map((link) => ({
        id: link.id,
        platform: link.platform,
        workspaceId: link.workspace_id,
        workspaceLabel: link.workspace_label,
        memberId: link.member_id,
        memberLabel: link.member_label,
        allowed: allowed
          .filter((entry) => entry.link_id === link.id)
          .map((entry) => ({ id: entry.id, kind: entry.kind, value: entry.value, label: entry.label })),
      })),
    };
  });

  app.post('/v1/chat/link-codes', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    await assertCanSync(context, Boolean(auth.user.email_verified));
    const { platform } = z.object({ platform: platformSchema }).strict().parse(request.body);
    if (!enabled(platform))
      throw new ApiError(404, 'chat_unavailable', 'This server is not set up for this chat app');
    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await db
      .prepare('DELETE FROM chat_link_codes WHERE user_id = ? AND platform = ?')
      .run(auth.user.id, platform);
    await db
      .prepare('INSERT INTO chat_link_codes (code_hash, user_id, platform, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(code), auth.user.id, platform, expiresAt);
    return reply.code(201).send({ code, expiresAt });
  });

  app.delete('/v1/chat/links/:id', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    const id = idParam(request);
    const deleted = await db
      .prepare('DELETE FROM chat_links WHERE id = ? AND user_id = ?')
      .run(id, auth.user.id);
    if (!deleted.changes) throw new ApiError(404, 'chat_link_not_found', 'Link not found or not accessible');
    await audit(db, auth.user.id, 'chat.unlink', id, null, clientIp(request));
    return reply.code(204).send();
  });

  app.post('/v1/chat/links/:id/allowed', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    const id = idParam(request);
    const input = z
      .object({ kind: z.enum(['channel', 'member']), value: chatId, label: label.optional() })
      .strict()
      .parse(request.body);
    const link = await db
      .prepare('SELECT id FROM chat_links WHERE id = ? AND user_id = ?')
      .get(id, auth.user.id);
    if (!link) throw new ApiError(404, 'chat_link_not_found', 'Link not found or not accessible');
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM chat_allowed WHERE link_id = ?')
      .get<{ n: number | string }>(id);
    if (Number(count?.n ?? 0) >= MAX_ALLOWED_PER_LINK) {
      throw new ApiError(
        409,
        'chat_allowed_limit',
        `At most ${MAX_ALLOWED_PER_LINK} channels and people per link`,
      );
    }
    const existing = await db
      .prepare('SELECT id FROM chat_allowed WHERE link_id = ? AND kind = ? AND value = ?')
      .get<{ id: string }>(id, input.kind, input.value);
    const entryId = existing?.id ?? newId();
    if (!existing) {
      await db
        .prepare(
          'INSERT INTO chat_allowed (id, link_id, kind, value, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(entryId, id, input.kind, input.value, input.label || input.value, nowIso());
      await audit(db, auth.user.id, 'chat.allow', id, { kind: input.kind }, clientIp(request));
    }
    return reply
      .code(201)
      .send({ id: entryId, kind: input.kind, value: input.value, label: input.label || input.value });
  });

  app.delete('/v1/chat/allowed/:id', async (request, reply) => {
    const auth = await requireAuth(db, config, request);
    const id = idParam(request);
    const deleted = await db
      .prepare(
        'DELETE FROM chat_allowed WHERE id = ? AND link_id IN (SELECT id FROM chat_links WHERE user_id = ?)',
      )
      .run(id, auth.user.id);
    if (!deleted.changes) throw new ApiError(404, 'chat_allowed_not_found', 'Not found or not accessible');
    return reply.code(204).send();
  });

  /** The requests that wait for this account; each is handed out once. */
  app.post('/v1/chat/requests/take', async (request) => {
    const auth = await requireAuth(db, config, request);
    const now = nowIso();
    const rows = await db
      .prepare(
        `SELECT r.id, r.channel_id, r.channel_label, r.member_id, r.member_label, r.text, r.created_at, r.expires_at,
                l.platform, l.workspace_label
         FROM chat_requests r JOIN chat_links l ON l.id = r.link_id
         WHERE r.user_id = ? AND r.taken_at IS NULL AND r.expires_at > ? ORDER BY r.seq, r.created_at, r.id`,
      )
      .all<{
        id: string;
        channel_id: string;
        channel_label: string;
        member_id: string;
        member_label: string;
        text: string;
        created_at: string;
        expires_at: string;
        platform: ChatPlatform;
        workspace_label: string;
      }>(auth.user.id, now);
    for (const row of rows) {
      await db
        .prepare('UPDATE chat_requests SET taken_at = ? WHERE id = ? AND user_id = ?')
        .run(now, row.id, auth.user.id);
    }
    return {
      requests: rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        workspaceLabel: row.workspace_label,
        channelId: row.channel_id,
        channelLabel: row.channel_label,
        memberLabel: row.member_label,
        text: row.text,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    };
  });

  /** Posts the person's reply in the request's channel. Text only. */
  app.post('/v1/chat/requests/:id/reply', async (request) => {
    const auth = await requireAuth(db, config, request);
    await assertNotInMaintenance(context);
    const id = idParam(request);
    const { text } = z
      .object({ text: z.string().trim().min(1).max(MAX_REPLY_CHARS) })
      .strict()
      .parse(request.body);
    const row = await db
      .prepare(
        `SELECT r.channel_id, r.member_id, l.platform FROM chat_requests r JOIN chat_links l ON l.id = r.link_id
         WHERE r.id = ? AND r.user_id = ? AND r.expires_at > ?`,
      )
      .get<{ channel_id: string; member_id: string; platform: ChatPlatform }>(id, auth.user.id, nowIso());
    if (!row) throw new ApiError(404, 'chat_request_not_found', 'This request has expired or was removed');
    if (!enabled(row.platform))
      throw new ApiError(404, 'chat_unavailable', 'This server is not set up for this chat app');
    // Claim a reply before posting, so replies sent at the same time cannot pass the limit.
    const claimed = await db
      .prepare('UPDATE chat_requests SET replies = replies + 1 WHERE id = ? AND user_id = ? AND replies < ?')
      .run(id, auth.user.id, MAX_REPLIES);
    if (!claimed.changes) {
      throw new ApiError(409, 'chat_reply_limit', 'This request was answered three times already');
    }
    const posted = await postChatReply(
      config,
      { platform: row.platform, channelId: row.channel_id, memberId: row.member_id },
      clean(text, MAX_REPLY_CHARS),
    );
    if (!posted) {
      // A reply the chat app did not take does not count.
      await db.prepare('UPDATE chat_requests SET replies = replies - 1 WHERE id = ? AND replies > 0').run(id);
      throw new ApiError(502, 'chat_reply_failed', 'The chat app did not take the reply. Try again later');
    }
    await audit(db, auth.user.id, 'chat.reply', id, null, clientIp(request));
    return { posted: true };
  });

  // --- Chat apps ------------------------------------------------------------------

  /** What a chat command does; the answer is shown only to the person who typed it. */
  const handle = async (incoming: Incoming): Promise<string> => {
    const text = clean(incoming.text, MAX_REQUEST_CHARS);
    const link = /^link\s+([A-Za-z0-9]{8})$/i.exec(text);
    if (link) return await linkIdentity(incoming, link[1].toUpperCase());
    if (!text) return 'Type /ravelon followed by your request.';
    if (config.rateLimit.enabled) {
      try {
        limiter.hit(`chat:${incoming.platform}:${incoming.workspaceId}`, REQUESTS_PER_WORKSPACE_PER_MIN);
      } catch {
        return 'Too many requests from this workspace. Try again in a minute.';
      }
    }
    const targets = await db
      .prepare(
        `SELECT l.id, l.user_id FROM chat_links l
         WHERE l.platform = ? AND l.workspace_id = ?
           AND EXISTS (SELECT 1 FROM chat_allowed a WHERE a.link_id = l.id AND a.kind = 'channel' AND a.value = ?)
           AND EXISTS (SELECT 1 FROM chat_allowed a WHERE a.link_id = l.id AND a.kind = 'member' AND a.value = ?)`,
      )
      .all<{ id: string; user_id: string }>(
        incoming.platform,
        incoming.workspaceId,
        incoming.channelId,
        incoming.memberId,
      );
    if (targets.length === 0) return 'Ravelon is not set up for this channel or for you.';
    const now = new Date();
    for (const target of targets) {
      await db.transaction(async () => {
        // One account's sequence: serialized on PostgreSQL; SQLite transactions are already serialized.
        if (db.dialect === 'postgres')
          await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(target.user_id);
        const last = await db
          .prepare('SELECT MAX(seq) AS n FROM chat_requests WHERE user_id = ?')
          .get<{ n: number | string | null }>(target.user_id);
        await db
          .prepare(
            `INSERT INTO chat_requests (id, user_id, link_id, channel_id, channel_label, member_id, member_label, text, created_at, expires_at, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId(),
            target.user_id,
            target.id,
            incoming.channelId,
            clean(incoming.channelLabel, 120) || incoming.channelId,
            incoming.memberId,
            clean(incoming.memberLabel, 120) || incoming.memberId,
            text,
            now.toISOString(),
            new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
            Number(last?.n ?? 0) + 1,
          );
        // Waiting requests beyond the limit make room, oldest first.
        const waiting = await db
          .prepare(
            'SELECT id FROM chat_requests WHERE user_id = ? AND taken_at IS NULL ORDER BY seq DESC, created_at DESC, id DESC',
          )
          .all<{ id: string }>(target.user_id);
        for (const old of waiting.slice(MAX_WAITING_PER_USER)) {
          await db.prepare('DELETE FROM chat_requests WHERE id = ?').run(old.id);
        }
      })();
    }
    return 'Sent to Ravelon. Nothing runs until someone starts it on their computer.';
  };

  const linkIdentity = async (incoming: Incoming, code: string): Promise<string> => {
    const now = nowIso();
    const found = await db
      .prepare('SELECT user_id FROM chat_link_codes WHERE code_hash = ? AND platform = ? AND expires_at > ?')
      .get<{ user_id: string }>(sha256(code), incoming.platform, now);
    if (!found) return 'This code is not valid. Create a new one in Ravelon.';
    await db.prepare('DELETE FROM chat_link_codes WHERE code_hash = ?').run(sha256(code));
    const taken = await db
      .prepare('SELECT user_id FROM chat_links WHERE platform = ? AND workspace_id = ? AND member_id = ?')
      .get<{ user_id: string }>(incoming.platform, incoming.workspaceId, incoming.memberId);
    if (taken && taken.user_id !== found.user_id) {
      return 'This chat account is linked to another Ravelon account. Unlink it there first.';
    }
    const linkId =
      (
        await db
          .prepare('SELECT id FROM chat_links WHERE platform = ? AND workspace_id = ? AND member_id = ?')
          .get<{ id: string }>(incoming.platform, incoming.workspaceId, incoming.memberId)
      )?.id ?? newId();
    await db.transaction(async () => {
      if (!taken) {
        await db
          .prepare(
            `INSERT INTO chat_links (id, user_id, platform, workspace_id, workspace_label, member_id, member_label, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            linkId,
            found.user_id,
            incoming.platform,
            incoming.workspaceId,
            clean(incoming.workspaceLabel, 120) || incoming.workspaceId,
            incoming.memberId,
            clean(incoming.memberLabel, 120) || incoming.memberId,
            now,
          );
      }
      for (const [kind, value, entryLabel] of [
        ['channel', incoming.channelId, incoming.channelLabel],
        ['member', incoming.memberId, incoming.memberLabel],
      ] as const) {
        const exists = await db
          .prepare('SELECT id FROM chat_allowed WHERE link_id = ? AND kind = ? AND value = ?')
          .get(linkId, kind, value);
        if (!exists) {
          await db
            .prepare(
              'INSERT INTO chat_allowed (id, link_id, kind, value, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(newId(), linkId, kind, value, clean(entryLabel, 120) || value, now);
        }
      }
    })();
    await audit(db, found.user_id, 'chat.link', linkId, { platform: incoming.platform }, null);
    return 'Linked to Ravelon. Requests you send from this channel now reach your computer as drafts.';
  };

  const platformLimit = (request: FastifyRequest) => {
    if (config.rateLimit.enabled) limiter.hit(`chat-app:${clientIp(request)}`, PLATFORM_PER_IP_PER_MIN);
  };

  // Each chat app signs the exact bytes it sent, so these routes read the body as text.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_request, body, done) => done(null, body),
    );
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_request, body, done) => done(null, body),
    );

    scope.post('/v1/chat/slack/commands', async (request, reply) => {
      platformLimit(request);
      const slack = config.chat.slack;
      if (!slack) throw new ApiError(404, 'chat_unavailable', 'This server is not set up for this chat app');
      const raw = typeof request.body === 'string' ? request.body : '';
      const valid = slackSignatureValid(
        slack.signingSecret,
        header(request, 'x-slack-request-timestamp'),
        header(request, 'x-slack-signature'),
        raw,
      );
      if (!valid) throw new ApiError(401, 'invalid_signature', 'Invalid signature');
      const form = new URLSearchParams(raw);
      const ids = z.object({ team_id: chatId, channel_id: chatId, user_id: chatId }).parse({
        team_id: form.get('team_id'),
        channel_id: form.get('channel_id'),
        user_id: form.get('user_id'),
      });
      const answer = await handle({
        platform: 'slack',
        workspaceId: ids.team_id,
        workspaceLabel: form.get('team_domain') ?? '',
        channelId: ids.channel_id,
        channelLabel: form.get('channel_name') ?? '',
        memberId: ids.user_id,
        memberLabel: form.get('user_name') ?? '',
        text: form.get('text') ?? '',
      });
      return ephemeral(reply, { response_type: 'ephemeral', text: answer });
    });

    scope.post('/v1/chat/discord/interactions', async (request, reply) => {
      platformLimit(request);
      const discord = config.chat.discord;
      if (!discord)
        throw new ApiError(404, 'chat_unavailable', 'This server is not set up for this chat app');
      const raw = typeof request.body === 'string' ? request.body : '';
      const valid = discordSignatureValid(
        discord.publicKey,
        header(request, 'x-signature-timestamp'),
        header(request, 'x-signature-ed25519'),
        raw,
      );
      if (!valid) throw new ApiError(401, 'invalid_signature', 'invalid request signature');
      const body = discordInteraction.parse(JSON.parse(raw));
      // Discord checks the endpoint with a ping before it sends commands.
      if (body.type === 1) return reply.send({ type: 1 });
      if (body.type !== 2 || body.data?.name !== 'ravelon' || !body.guild_id) {
        return ephemeral(reply, discordMessage('Use /ravelon in a server channel.'));
      }
      const sub = body.data.options?.[0];
      const value = String(sub?.options?.[0]?.value ?? '');
      const user = body.member?.user;
      if (!user) return ephemeral(reply, discordMessage('Use /ravelon in a server channel.'));
      const answer = await handle({
        platform: 'discord',
        workspaceId: body.guild_id,
        workspaceLabel: body.guild_id,
        channelId: body.channel_id ?? '',
        channelLabel: body.channel?.name ?? body.channel_id ?? '',
        memberId: user.id,
        memberLabel: user.global_name || user.username || user.id,
        text: sub?.name === 'link' ? `link ${value}` : value,
      });
      return ephemeral(reply, discordMessage(answer));
    });
  });
}

const discordInteraction = z.object({
  type: z.number().int(),
  guild_id: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  channel_id: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  channel: z.object({ name: z.string().max(200).optional() }).optional(),
  member: z
    .object({
      user: z.object({
        id: z.string().regex(/^\d{1,30}$/),
        username: z.string().max(100).optional(),
        global_name: z.string().max(100).nullable().optional(),
      }),
    })
    .optional(),
  data: z
    .object({
      name: z.string(),
      options: z
        .array(
          z.object({
            name: z.string(),
            options: z
              .array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]) }))
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Discord's "reply with a message only the person sees". */
function discordMessage(content: string) {
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

function ephemeral(reply: FastifyReply, body: unknown): FastifyReply {
  return reply.header('Cache-Control', 'no-store').send(body);
}

/** Old codes and requests, for the daily cleanup. Reads check the expiry themselves. */
export async function deleteExpiredChatRequests(db: RouteContext['db'], now: string): Promise<void> {
  await db.prepare('DELETE FROM chat_link_codes WHERE expires_at < ?').run(now);
  await db.prepare('DELETE FROM chat_requests WHERE expires_at < ?').run(now);
}
