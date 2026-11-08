import { createHmac, createPublicKey, verify } from 'node:crypto';

import type { Config } from '../config.js';
import { safeEqual } from './crypto.js';

/**
 * What Slack and Discord need from this server: proof that a request came
 * from them (Slack signs with HMAC-SHA256, Discord with Ed25519) and a way
 * to post a reply with the bot token. The tokens and secrets come from the
 * environment and are never returned or logged.
 */

export type ChatPlatform = 'slack' | 'discord';
export const CHAT_PLATFORMS: readonly ChatPlatform[] = ['slack', 'discord'];

/** Slack refuses requests older than five minutes; so does this server, against replays. */
const MAX_SKEW_SECONDS = 5 * 60;

/** Whether `raw` is a Slack request signed with the app's signing secret within five minutes of `now`. */
export function slackSignatureValid(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  raw: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return safeEqual(expected, signature);
}

/** Whether `raw` is a Discord interaction signed with the application's Ed25519 key within five minutes of `now`. */
export function discordSignatureValid(
  publicKeyHex: string,
  timestamp: string | undefined,
  signatureHex: string | undefined,
  raw: string,
  now = Date.now(),
): boolean {
  if (
    !timestamp ||
    !signatureHex ||
    !/^\d{1,12}$/.test(timestamp) ||
    !/^[0-9a-fA-F]{128}$/.test(signatureHex)
  ) {
    return false;
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
      format: 'jwk',
    });
    return verify(null, Buffer.from(timestamp + raw), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Where a reply goes and who it answers. */
export interface ReplyTarget {
  platform: ChatPlatform;
  channelId: string;
  memberId: string;
}

export type ChatFetch = (url: string, init: RequestInit) => Promise<Response>;

let transport: ChatFetch = (url, init) => fetch(url, init);

/** Tests replace the network; nothing else may. */
export function setChatTransportForTests(next: ChatFetch | null): void {
  transport = next ?? ((url, init) => fetch(url, init));
}

/** Slack text with `&`, `<` and `>` escaped, so a reply cannot mention a channel or a group. */
function slackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Posts `text` in the request's channel, addressed to the person who asked.
 * Mentions in the text do not notify anyone: Slack gets it escaped, Discord
 * with no mention allowed but the requester. Returns whether the platform
 * took it.
 */
export async function postChatReply(config: Config, target: ReplyTarget, text: string): Promise<boolean> {
  try {
    if (target.platform === 'slack' && config.chat.slack) {
      const response = await transport('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.chat.slack.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: target.channelId, text: `<@${target.memberId}> ${slackText(text)}` }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return response.ok && body?.ok === true;
    }
    if (target.platform === 'discord' && config.chat.discord) {
      const response = await transport(`https://discord.com/api/v10/channels/${target.channelId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${config.chat.discord.botToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `<@${target.memberId}> ${text}`.slice(0, 2000),
          allowed_mentions: { parse: [], users: [target.memberId] },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    }
  } catch {
    // A platform that does not answer is a failed post, not a server error.
  }
  return false;
}
