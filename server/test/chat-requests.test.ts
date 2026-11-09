import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';
import { setChatTransportForTests } from '../src/lib/chat-platforms.js';
import { deleteExpiredChatRequests, MAX_WAITING_PER_USER } from '../src/routes/chat-requests.js';
import { api, register, startTestServer, type TestServer } from './helpers.js';

const SLACK_SECRET = 'slack-signing-secret-for-tests';
const discordKeys = generateKeyPairSync('ed25519');
const discordPublicHex = Buffer.from(
  (discordKeys.publicKey.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
).toString('hex');

async function slack(
  server: TestServer,
  fields: Record<string, string>,
  options: { secret?: string; age?: number } = {},
) {
  const raw = new URLSearchParams({
    team_id: 'T0001',
    team_domain: 'acme',
    channel_id: 'C0001',
    channel_name: 'dev',
    user_id: 'U0001',
    user_name: 'ana',
    command: '/ravelon',
    ...fields,
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000) - (options.age ?? 0));
  const signature = `v0=${createHmac('sha256', options.secret ?? SLACK_SECRET)
    .update(`v0:${timestamp}:${raw}`)
    .digest('hex')}`;
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/chat/slack/commands',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    payload: raw,
  });
  return { status: response.statusCode, body: response.json() };
}

async function discord(server: TestServer, body: object, options: { forged?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signer = options.forged ? generateKeyPairSync('ed25519').privateKey : discordKeys.privateKey;
  const signature = sign(null, Buffer.from(timestamp + raw), signer).toString('hex');
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/chat/discord/interactions',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    payload: raw,
  });
  return { status: response.statusCode, body: response.json() };
}

const discordCommand = (sub: 'link' | 'ask', value: string, user = '42', channel = '900') => ({
  type: 2,
  guild_id: '700',
  channel_id: channel,
  channel: { name: 'general' },
  member: { user: { id: user, username: 'bo', global_name: 'Bo' } },
  data: {
    name: 'ravelon',
    options: [{ name: sub, options: [{ name: sub === 'link' ? 'code' : 'text', value }] }],
  },
});

describe('chat requests', () => {
  let server: TestServer;
  const posts: { url: string; init: RequestInit }[] = [];

  before(async () => {
    server = await startTestServer({
      SLACK_SIGNING_SECRET: SLACK_SECRET,
      SLACK_BOT_TOKEN: 'xoxb-test-token',
      DISCORD_PUBLIC_KEY: discordPublicHex,
      DISCORD_BOT_TOKEN: 'discord-test-token',
    });
    const admin = await register(server, 'admin@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
    setChatTransportForTests(async (url, init) => {
      posts.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  });

  after(async () => {
    setChatTransportForTests(null);
    await server.close();
  });

  test('a Slack identity is linked by a one-time code, and only allowed channels and people reach the account', async () => {
    const owner = await register(server, 'owner@example.com');
    const settings = await api(server, 'GET', '/v1/chat', { token: owner.accessToken });
    assert.deepEqual(settings.body.platforms, { slack: true, discord: true });
    // Never a token or secret in what the desktop reads.
    assert.doesNotMatch(JSON.stringify(settings.body), /xoxb|discord-test-token|slack-signing/);

    const code = await api(server, 'POST', '/v1/chat/link-codes', {
      token: owner.accessToken,
      body: { platform: 'slack' },
    });
    assert.equal(code.status, 201);
    assert.match(code.body.code, /^[A-HJ-NP-Z2-9]{8}$/);

    // Before linking, nothing reaches anyone.
    const early = await slack(server, { text: 'fix the build' });
    assert.match(early.body.text, /not set up/);

    const linked = await slack(server, { text: `link ${code.body.code.toLowerCase()}` });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.response_type, 'ephemeral');
    assert.match(linked.body.text, /Linked/);
    // The code works once.
    assert.match((await slack(server, { text: `link ${code.body.code}` })).body.text, /not valid/);

    const after = await api(server, 'GET', '/v1/chat', { token: owner.accessToken });
    const [link] = after.body.links;
    assert.equal(link.platform, 'slack');
    assert.deepEqual(
      link.allowed.map((entry: { kind: string; value: string }) => `${entry.kind}:${entry.value}`).sort(),
      ['channel:C0001', 'member:U0001'],
    );

    // Control characters other than line breaks and tabs are dropped on the way in.
    assert.match((await slack(server, { text: 'fix the\u0007 build\u0000' })).body.text, /Nothing runs/);
    assert.match(
      (await slack(server, { text: 'from elsewhere', channel_id: 'C0002' })).body.text,
      /not set up/,
    );
    assert.match(
      (await slack(server, { text: 'from someone else', user_id: 'U0002' })).body.text,
      /not set up/,
    );
    assert.match(
      (await slack(server, { text: 'other workspace', team_id: 'T0002' })).body.text,
      /not set up/,
    );

    const taken = await api(server, 'POST', '/v1/chat/requests/take', { token: owner.accessToken });
    assert.deepEqual(
      taken.body.requests.map((entry: { text: string }) => entry.text),
      ['fix the build'],
    );
    assert.equal(taken.body.requests[0].memberLabel, 'ana');
    assert.equal(taken.body.requests[0].channelLabel, 'dev');
    // Handed out once.
    assert.deepEqual(
      (await api(server, 'POST', '/v1/chat/requests/take', { token: owner.accessToken })).body.requests,
      [],
    );

    // Allowing another person by id lets them through.
    const allowed = await api(server, 'POST', `/v1/chat/links/${link.id}/allowed`, {
      token: owner.accessToken,
      body: { kind: 'member', value: 'U0002', label: 'ben' },
    });
    assert.equal(allowed.status, 201);
    assert.match((await slack(server, { text: 'now allowed', user_id: 'U0002' })).body.text, /Nothing runs/);
    // Removing it closes the door again.
    await api(server, 'DELETE', `/v1/chat/allowed/${allowed.body.id}`, { token: owner.accessToken });
    assert.match((await slack(server, { text: 'not anymore', user_id: 'U0002' })).body.text, /not set up/);
  });

  test('requests with a wrong, missing or stale signature are refused', async () => {
    assert.equal((await slack(server, { text: 'x' }, { secret: 'wrong' })).status, 401);
    assert.equal((await slack(server, { text: 'x' }, { age: 10 * 60 })).status, 401);
    const unsigned = await server.app.inject({
      method: 'POST',
      url: '/v1/chat/slack/commands',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'text=x',
    });
    assert.equal(unsigned.statusCode, 401);
    assert.equal((await discord(server, { type: 1 }, { forged: true })).status, 401);
  });

  test('Discord: the ping is answered, then link and ask work like in Slack', async () => {
    const owner = await register(server, 'discord@example.com');
    const ping = await discord(server, { type: 1 });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { type: 1 });
    const code = await api(server, 'POST', '/v1/chat/link-codes', {
      token: owner.accessToken,
      body: { platform: 'discord' },
    });
    const linked = await discord(server, discordCommand('link', code.body.code));
    assert.equal(linked.body.type, 4);
    assert.equal(linked.body.data.flags, 64);
    assert.match(linked.body.data.content, /Linked/);
    assert.match(
      (await discord(server, discordCommand('ask', 'deploy staging'))).body.data.content,
      /Nothing runs/,
    );
    assert.match((await discord(server, discordCommand('ask', 'x', '43'))).body.data.content, /not set up/);
    const taken = await api(server, 'POST', '/v1/chat/requests/take', { token: owner.accessToken });
    assert.equal(taken.body.requests[0].platform, 'discord');
    assert.equal(taken.body.requests[0].memberLabel, 'Bo');

    posts.length = 0;
    const replied = await api(server, 'POST', `/v1/chat/requests/${taken.body.requests[0].id}/reply`, {
      token: owner.accessToken,
      body: { text: 'Done @everyone' },
    });
    assert.equal(replied.status, 200);
    assert.equal(posts[0].url, 'https://discord.com/api/v10/channels/900/messages');
    assert.equal((posts[0].init.headers as Record<string, string>).authorization, 'Bot discord-test-token');
    const sent = JSON.parse(String(posts[0].init.body));
    assert.equal(sent.content, '<@42> Done @everyone');
    assert.deepEqual(sent.allowed_mentions, { parse: [], users: ['42'] });
  });

  test('a reply goes to the request channel as escaped text, only from the account it reached, at most three times', async () => {
    const owner = await register(server, 'replies@example.com');
    const other = await register(server, 'mallory@example.com');
    const code = await api(server, 'POST', '/v1/chat/link-codes', {
      token: owner.accessToken,
      body: { platform: 'slack' },
    });
    await slack(server, {
      text: `link ${code.body.code}`,
      team_id: 'T0009',
      user_id: 'U0009',
      channel_id: 'C0009',
    });
    await slack(server, {
      text: 'summarise the incident',
      team_id: 'T0009',
      user_id: 'U0009',
      channel_id: 'C0009',
    });
    const [request] = (await api(server, 'POST', '/v1/chat/requests/take', { token: owner.accessToken })).body
      .requests;

    const stranger = await api(server, 'POST', `/v1/chat/requests/${request.id}/reply`, {
      token: other.accessToken,
      body: { text: 'hi' },
    });
    assert.equal(stranger.status, 404);

    posts.length = 0;
    for (let index = 0; index < 3; index += 1) {
      const ok = await api(server, 'POST', `/v1/chat/requests/${request.id}/reply`, {
        token: owner.accessToken,
        body: { text: 'All good <!channel> & done' },
      });
      assert.equal(ok.status, 200);
    }
    assert.equal(posts[0].url, 'https://slack.com/api/chat.postMessage');
    assert.equal((posts[0].init.headers as Record<string, string>).authorization, 'Bearer xoxb-test-token');
    assert.deepEqual(JSON.parse(String(posts[0].init.body)), {
      channel: 'C0009',
      text: '<@U0009> All good &lt;!channel&gt; &amp; done',
    });
    const fourth = await api(server, 'POST', `/v1/chat/requests/${request.id}/reply`, {
      token: owner.accessToken,
      body: { text: 'again' },
    });
    assert.equal(fourth.status, 409);
    const tooLong = await api(server, 'POST', `/v1/chat/requests/${request.id}/reply`, {
      token: owner.accessToken,
      body: { text: 'x'.repeat(3001) },
    });
    assert.equal(tooLong.status, 400);
  });

  test('a chat identity belongs to one account, and only its owner manages the link', async () => {
    const first = await register(server, 'first@example.com');
    const second = await register(server, 'second@example.com');
    const one = await api(server, 'POST', '/v1/chat/link-codes', {
      token: first.accessToken,
      body: { platform: 'slack' },
    });
    await slack(server, { text: `link ${one.body.code}`, team_id: 'T0100', user_id: 'U0100' });
    const two = await api(server, 'POST', '/v1/chat/link-codes', {
      token: second.accessToken,
      body: { platform: 'slack' },
    });
    const refused = await slack(server, {
      text: `link ${two.body.code}`,
      team_id: 'T0100',
      user_id: 'U0100',
    });
    assert.match(refused.body.text, /another Ravelon account/);
    assert.deepEqual((await api(server, 'GET', '/v1/chat', { token: second.accessToken })).body.links, []);

    const [link] = (await api(server, 'GET', '/v1/chat', { token: first.accessToken })).body.links;
    assert.equal(
      (await api(server, 'DELETE', `/v1/chat/links/${link.id}`, { token: second.accessToken })).status,
      404,
    );
    assert.equal(
      (
        await api(server, 'POST', `/v1/chat/links/${link.id}/allowed`, {
          token: second.accessToken,
          body: { kind: 'channel', value: 'C0200' },
        })
      ).status,
      404,
    );
    assert.equal(
      (await api(server, 'DELETE', `/v1/chat/links/${link.id}`, { token: first.accessToken })).status,
      204,
    );
    assert.match(
      (await slack(server, { text: 'after unlink', team_id: 'T0100', user_id: 'U0100' })).body.text,
      /not set up/,
    );
  });

  test('waiting requests are capped per account, and old ones are cleaned up', async () => {
    const owner = await register(server, 'busy@example.com');
    const code = await api(server, 'POST', '/v1/chat/link-codes', {
      token: owner.accessToken,
      body: { platform: 'slack' },
    });
    const where = { team_id: 'T0300', user_id: 'U0300', channel_id: 'C0300' };
    await slack(server, { text: `link ${code.body.code}`, ...where });
    for (let index = 0; index <= MAX_WAITING_PER_USER; index += 1)
      await slack(server, { text: `request ${index}`, ...where });
    const taken = (await api(server, 'POST', '/v1/chat/requests/take', { token: owner.accessToken })).body
      .requests;
    assert.equal(taken.length, MAX_WAITING_PER_USER);
    assert.equal(taken[0].text, 'request 1');

    await server.db
      .prepare('UPDATE chat_requests SET expires_at = ? WHERE user_id = ?')
      .run('2000-01-01T00:00:00.000Z', owner.userId);
    await deleteExpiredChatRequests(server.db, new Date().toISOString());
    const left = await server.db
      .prepare('SELECT COUNT(*) AS n FROM chat_requests WHERE user_id = ?')
      .get<{ n: number }>(owner.userId);
    assert.equal(Number(left?.n), 0);
  });
});

describe('chat requests without chat apps', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  test('nothing is offered and the chat app routes do not answer', async () => {
    const owner = await register(server, 'plain@example.com');
    const settings = await api(server, 'GET', '/v1/chat', { token: owner.accessToken });
    assert.deepEqual(settings.body.platforms, { slack: false, discord: false });
    const code = await api(server, 'POST', '/v1/chat/link-codes', {
      token: owner.accessToken,
      body: { platform: 'slack' },
    });
    assert.equal(code.status, 404);
    const command = await server.app.inject({
      method: 'POST',
      url: '/v1/chat/slack/commands',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'text=x',
    });
    assert.equal(command.statusCode, 404);
    assert.equal((await api(server, 'GET', '/v1/chat')).status, 401);
  });
});

describe('chat app configuration', () => {
  test('a platform is offered only with both of its values, and a malformed Discord key stops the start', () => {
    const base = {
      NODE_ENV: 'test',
      SYNC_JWT_SECRET: 'test-secret-that-is-long-enough-for-tests-0123456789',
    };
    assert.deepEqual(loadConfig({ ...base, SLACK_SIGNING_SECRET: 's' } as NodeJS.ProcessEnv).chat, {});
    assert.ok(
      loadConfig({ ...base, SLACK_SIGNING_SECRET: 's', SLACK_BOT_TOKEN: 't' } as NodeJS.ProcessEnv).chat
        .slack,
    );
    assert.throws(
      () =>
        loadConfig({ ...base, DISCORD_PUBLIC_KEY: 'not-hex', DISCORD_BOT_TOKEN: 't' } as NodeJS.ProcessEnv),
      ConfigError,
    );
  });
});
