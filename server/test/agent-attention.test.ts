import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { api, login, register, startTestServer, syncItem } from './helpers.js';

const device = {
  token: 'ab'.repeat(32),
  platform: 'ios',
  environment: 'development',
  topic: 'app.ravelon.ios',
};
const ref = Buffer.alloc(40, 7).toString('base64url');
const relayEnv = {
  PUSH_TEST_POSTGRES: process.env.TEST_DATABASE_URL ? '1' : '0',
  PUSH_RELAY_URL: 'https://relay.example.test',
  PUSH_RELAY_SHARED_TOKEN: 'test-relay-token-at-least-32-characters',
};
async function fixture(
  onFetch?: (url: string, body: Record<string, unknown>) => Promise<Response | undefined>,
) {
  const calls: Array<{
    url: string;
    method: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }> = [];
  const server = await startTestServer(relayEnv, {
    pushRelayFetch: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      const response = await onFetch?.(url, body);
      return (
        response ??
        Response.json(
          url.endsWith('/wake')
            ? { accepted: (body.subscriptionIds as unknown[]).length }
            : { registered: true },
        )
      );
    },
  });
  const owner = await register(server, 'owner@example.test');
  await api(server, 'PUT', '/v1/admin/settings/platform', {
    token: owner.accessToken,
    body: { serverName: 'Test', registrationMode: 'open' },
  });
  const phone = await login(server, owner.email, owner.password, { platform: 'ios' });
  assert.equal(phone.status, 200);
  const host = await api(server, 'POST', '/v1/agents/hosts', {
    token: owner.accessToken,
    body: { clientId: randomUUID(), label: 'Computer' },
  });
  assert.equal(host.status, 200);
  return {
    server,
    owner,
    phone: phone.body,
    hostId: host.body.id as string,
    calls,
    registerPhone: (agentAlerts?: boolean) =>
      api(server, 'POST', '/v1/push/devices', {
        token: phone.body.accessToken,
        body: { ...device, ...(agentAlerts === undefined ? {} : { agentAlerts }) },
      }),
    send: (body: unknown = { v: 1, event: 'approval', ref }, token = owner.accessToken) =>
      api(server, 'POST', `/v1/agents/hosts/${host.body.id}/attention`, { token, body }),
  };
}

test('HTTPS push relay requires complete explicit configuration and refuses secret-bearing URLs', () => {
  for (const values of [
    { PUSH_RELAY_URL: 'http://relay.test', PUSH_RELAY_SHARED_TOKEN: 'test-secret' },
    { PUSH_RELAY_URL: 'https://user:secret@relay.test', PUSH_RELAY_SHARED_TOKEN: 'test-secret' },
    { PUSH_RELAY_URL: 'https://relay.test?token=secret', PUSH_RELAY_SHARED_TOKEN: 'test-secret' },
    { PUSH_RELAY_URL: 'https://relay.test' },
    { PUSH_RELAY_SHARED_TOKEN: 'test-secret' },
  ]) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ...values }));
  }
});

test('disabled push relay stores no token and advertises no attention capability', async () => {
  const s = await startTestServer();
  try {
    const a = await register(s, 'disabled@example.test');
    assert.deepEqual(
      (
        await api(s, 'POST', '/v1/push/devices', {
          token: a.accessToken,
          body: { ...device, agentAlerts: true },
        })
      ).body,
      { registered: false },
    );
    assert.equal(
      (await api(s, 'GET', '/v1/agents/capabilities', { token: a.accessToken })).body.attention,
      undefined,
    );
  } finally {
    await s.close();
  }
});

test('self-hosted relay is free, default-off and sends only sealed metadata via the fixed HTTPS endpoint', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await api(f.server, 'GET', '/v1/agents/capabilities', { token: f.owner.accessToken })).body.attention,
      1,
    );
    assert.deepEqual((await f.registerPhone()).body, { registered: true });
    assert.deepEqual((await f.send()).body, { accepted: 0 });
    await f.server.db.prepare('DELETE FROM agent_attention_limits').run();
    await f.registerPhone(true);
    const result = await f.send();
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, { accepted: 1 });
    const wake = f.calls.find((call) => call.url.endsWith('/wake'))!;
    assert.equal(wake.url, 'https://relay.example.test/v1/relay/wake');
    assert.equal(wake.authorization, `Bearer ${relayEnv.PUSH_RELAY_SHARED_TOKEN}`);
    assert.deepEqual(wake.body.event, {
      type: 'agentAttention',
      hostId: f.hostId,
      v: 1,
      event: 'approval',
      ref,
    });
    assert.equal((wake.body.subscriptionIds as string[]).length, 1);
    assert.match((wake.body.subscriptionIds as string[])[0], /^rps_[a-f0-9]{32}$/);
    const registration = f.calls.filter((call) => call.url.endsWith('/subscriptions')).at(-1)!;
    assert.equal(registration.body.agentAlerts, true);
    assert.equal(registration.body.token, device.token);
    assert.equal(JSON.stringify(wake.body).includes(f.owner.userId), false);
  } finally {
    await f.server.close();
  }
});

test('attention rejects controllers, outsiders, expired sessions, malformed payloads and excludes blocked phone IDs', async () => {
  const f = await fixture();
  try {
    await f.registerPhone(true);
    assert.equal((await f.send(undefined, f.phone.accessToken)).status, 403);
    const other = await register(f.server, 'outsider@example.test');
    assert.equal((await f.send(undefined, other.accessToken)).status, 404);
    for (const body of [
      { v: 2, event: 'approval', ref },
      { v: 1, event: 'other', ref },
      { v: 1, event: 'input', ref, text: 'secret' },
      { v: 1, event: 'input', ref: 'bad' },
      { v: 1, event: 'input', ref, excludedDeviceIds: [f.phone.deviceId, f.phone.deviceId] },
    ]) {
      assert.equal((await f.send(body)).status, 400);
    }
    assert.deepEqual(
      (await f.send({ v: 1, event: 'input', ref, excludedDeviceIds: [f.phone.deviceId] })).body,
      { accepted: 0 },
    );
    assert.equal(f.calls.filter((c) => c.url.endsWith('/wake')).length, 0);
    await f.server.db
      .prepare("UPDATE refresh_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE device_id = ?")
      .run(f.owner.deviceId);
    assert.equal((await f.send()).status, 401);
  } finally {
    await f.server.close();
  }
});

test('recipient expiry/revocation and ownership-scoped deletion stop delivery; rotation removes the old subscription', async () => {
  const f = await fixture();
  try {
    await f.registerPhone(true);
    const oldId = f.calls.find((call) => call.url.endsWith('/subscriptions'))!.body.subscriptionId as string;
    await api(f.server, 'POST', '/v1/push/devices', {
      token: f.phone.accessToken,
      body: { ...device, token: 'cd'.repeat(32), agentAlerts: true },
    });
    assert.ok(f.calls.some((call) => call.method === 'DELETE' && call.url.endsWith(oldId)));
    await api(f.server, 'DELETE', '/v1/push/devices', { token: f.owner.accessToken });
    assert.equal(
      (await f.server.db.prepare('SELECT COUNT(*) AS count FROM push_devices').get<{ count: number }>())
        ?.count,
      1,
    );
    await f.server.db
      .prepare("UPDATE refresh_tokens SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE device_id = ?")
      .run(f.phone.deviceId);
    assert.deepEqual((await f.send()).body, { accepted: 0 });
    assert.equal(f.calls.filter((call) => call.url.endsWith('/wake')).length, 0);
    assert.equal((await f.registerPhone(true)).status, 401);
  } finally {
    await f.server.close();
  }
});

test('relay failures are retryable with bounded guidance and host limits serialize requests', async () => {
  let fail = false;
  const f = await fixture(async (url) =>
    fail && url.endsWith('/wake')
      ? Response.json({}, { status: 429, headers: { 'Retry-After': '90000' } })
      : undefined,
  );
  try {
    await f.registerPhone(true);
    fail = true;
    const response = await f.server.app.inject({
      method: 'POST',
      url: `/v1/agents/hosts/${f.hostId}/attention`,
      headers: { authorization: `Bearer ${f.owner.accessToken}` },
      payload: { v: 1, event: 'approval', ref },
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '3600');
    const limited = await f.server.app.inject({
      method: 'POST',
      url: `/v1/agents/hosts/${f.hostId}/attention`,
      headers: { authorization: `Bearer ${f.owner.accessToken}` },
      payload: { v: 1, event: 'completed', ref },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '10');
  } finally {
    await f.server.close();
  }
});

test('a sign-out while relay registration is in flight cannot leave an enabled subscription', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (url) => {
    if (url.endsWith('/subscriptions'))
      await f.server.db
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ?')
        .run(new Date().toISOString(), f.phone.deviceId);
    return undefined;
  });
  try {
    assert.equal((await f.registerPhone(true)).status, 401);
    assert.equal(
      (await f.server.db.prepare('SELECT COUNT(*) AS count FROM push_devices').get<{ count: number }>())
        ?.count,
      0,
    );
    assert.ok(f.calls.some((call) => call.method === 'DELETE'));
  } finally {
    await f.server.close();
  }
});

test('existing encrypted sync mutations still forward vaultChanged without a sealed thread reference', async () => {
  const f = await fixture();
  try {
    await f.registerPhone();
    const response = await api(f.server, 'POST', '/v1/sync/push', {
      token: f.owner.accessToken,
      body: { vaultId: 'personal', items: [syncItem('host-1', 'personal')] },
    });
    assert.equal(response.status, 200);
    const wake = f.calls.find((call) => call.url.endsWith('/wake'));
    assert.ok(wake);
    assert.deepEqual(wake.body.event, { type: 'vaultChanged', cursor: response.body.cursor });
  } finally {
    await f.server.close();
  }
});

test('reference character bounds match iOS: 40 and 512 canonical characters accepted, over 512 refused', async () => {
  const f = await fixture();
  try {
    for (const length of [30, 384]) {
      await f.server.db.prepare('DELETE FROM agent_attention_limits').run();
      assert.equal(
        (await f.send({ v: 1, event: 'input', ref: Buffer.alloc(length, 7).toString('base64url') })).status,
        202,
      );
    }
    assert.equal(
      (await f.send({ v: 1, event: 'input', ref: Buffer.alloc(385, 7).toString('base64url') })).status,
      400,
    );
  } finally {
    await f.server.close();
  }
});
