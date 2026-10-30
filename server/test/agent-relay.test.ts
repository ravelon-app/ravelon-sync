import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { api, login, register, startTestServer } from './helpers.js';
async function fixture() {
  const s = await startTestServer();
  const a = await register(s, 'relay@example.test');
  await api(s, 'PUT', '/v1/admin/settings/platform', {
    token: a.accessToken,
    body: { serverName: 'Test', registrationMode: 'open' },
  });
  const b = await login(s, a.email, a.password);
  const o = await register(s, 'other@example.test');
  return {
    app: s.app,
    url: await s.app.listen({ host: '127.0.0.1', port: 0 }),
    owner: { token: a.accessToken, deviceId: a.deviceId },
    controller: { token: b.body.accessToken, deviceId: b.body.deviceId },
    outsider: { token: o.accessToken },
    async call(method: string, url: string, token?: string, body?: unknown) {
      return api(s, method, url, { token, body });
    },
    async revoke(deviceId: string) {
      await s.db
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ?')
        .run(new Date().toISOString(), deviceId);
    },
    close: () => s.close(),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function waitFor(condition: () => boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > until) throw new Error('relay event timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(f: Fixture, hostId: string, role: string, token: string, origin?: string) {
  const messages: Record<string, unknown>[] = [];
  let done!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    done = resolve;
  });
  const socket = new WebSocket(
    `${f.url.replace('http:', 'ws:')}/v1/agents/relay?hostId=${hostId}&role=${role}`,
    {
      headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
    },
  );
  socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
  socket.once('close', (code: number, reason: Buffer) => done({ code, reason: reason.toString() }));
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages, closed };
}
async function host(f: Fixture) {
  const r = await f.call('POST', '/v1/agents/hosts', f.owner.token, {
    clientId: randomUUID(),
    label: 'Work Mac',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.online, false);
  assert.match(r.body.id, /^[0-9a-f-]{36}$/);
  return r.body.id as string;
}

test('relay registers account-scoped hosts and prevents another device taking ownership', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await f.call('GET', '/v1/agents/capabilities')).status, 401);
  const caps = await f.call('GET', '/v1/agents/capabilities', f.owner.token);
  assert.deepEqual(caps.body, { protocol: 1, enabled: true, canConnect: true, hostLimit: 3 });
  const clientId = randomUUID();
  const first = await f.call('POST', '/v1/agents/hosts', f.owner.token, { clientId, label: 'Original' });
  assert.equal(first.status, 200);
  const update = await f.call('POST', '/v1/agents/hosts', f.owner.token, { clientId, label: 'Renamed' });
  assert.equal(update.body.id, first.body.id);
  assert.equal(update.body.label, 'Renamed');
  assert.equal(
    (await f.call('POST', '/v1/agents/hosts', f.controller.token, { clientId, label: 'Stolen' })).status,
    403,
  );
  assert.equal((await f.call('DELETE', `/v1/agents/hosts/${first.body.id}`, f.controller.token)).status, 404);
  assert.deepEqual((await f.call('GET', '/v1/agents/hosts', f.outsider.token)).body, { hosts: [] });
  await host(f);
  await host(f);
  assert.equal(
    (await f.call('POST', '/v1/agents/hosts', f.owner.token, { clientId: randomUUID(), label: 'Fourth' }))
      .status,
    409,
  );
  assert.equal(
    (await f.call('POST', '/v1/agents/hosts', f.owner.token, { clientId: 'not-uuid', label: 'Bad' })).status,
    400,
  );
  assert.equal((await f.call('DELETE', `/v1/agents/hosts/${first.body.id}`, f.owner.token)).status, 204);
});

test('relay routes opaque bodies only to the host and the server-selected controller', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = await host(f);
  const offline = await connect(f, id, 'controller', f.controller.token);
  assert.equal((await offline.closed).reason, 'host_offline');
  const h = await connect(f, id, 'host', f.owner.token);
  const c = await connect(f, id, 'controller', f.controller.token);
  await waitFor(() => c.messages.length === 1 && h.messages.length === 1);
  const routeId = c.messages[0].routeId;
  assert.deepEqual(c.messages[0], { type: 'connected', routeId, deviceId: f.controller.deviceId });
  assert.deepEqual(h.messages[0], { type: 'controllerJoined', routeId, deviceId: f.controller.deviceId });
  assert.equal((await f.call('GET', '/v1/agents/hosts', f.owner.token)).body.hosts[0].online, true);
  const opaque = { v: 1, grantId: randomUUID(), seq: 0, nonce: 'opaque', ciphertext: 'unreadable' };
  c.socket.send(JSON.stringify({ type: 'frame', body: opaque }));
  await waitFor(() => h.messages.length === 2);
  assert.deepEqual(h.messages[1], { type: 'frame', routeId, deviceId: f.controller.deviceId, body: opaque });
  h.socket.send(JSON.stringify({ type: 'frame', routeId, body: { kind: 'join', grantId: randomUUID() } }));
  await waitFor(() => c.messages.length === 2);
  assert.equal(c.messages[1].type, 'frame');
  assert.equal(c.messages[1].routeId, undefined);
  c.socket.close();
  await c.closed;
  await waitFor(() => h.messages.length === 3);
  assert.deepEqual(h.messages[2], { type: 'controllerLeft', routeId });
});

test('relay denies cross-account, owner-role and hostile browser handshakes', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = await host(f);
  for (const [role, token, origin] of [
    ['host', f.controller.token, undefined],
    ['controller', f.outsider.token, undefined],
    ['admin', f.owner.token, undefined],
    ['host', f.owner.token, 'https://attacker.test'],
  ] as const) {
    assert.equal((await (await connect(f, id, role, token, origin)).closed).code, 1008);
  }
});

test('relay rejects spoofed metadata, malformed frames and oversize frames before forwarding', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = await host(f);
  const h = await connect(f, id, 'host', f.owner.token);
  for (const payload of [
    JSON.stringify({ type: 'frame', routeId: randomUUID(), body: {} }),
    JSON.stringify({ type: 'frame', deviceId: f.owner.deviceId, body: {} }),
    JSON.stringify({ type: 'frame', body: [] }),
    '{',
    JSON.stringify({ type: 'frame', body: { text: 'x'.repeat(1024 * 1024) } }),
  ]) {
    const c = await connect(f, id, 'controller', f.controller.token);
    await waitFor(() => c.messages.length === 1);
    c.socket.send(payload);
    const closed = await c.closed;
    assert.ok(closed.code === 1008 || closed.code === 1009);
  }
  assert.equal(h.messages.filter((m) => m.type === 'frame').length, 0);
});

test('relay closes all controllers when host is replaced, deleted or revoked with no replay', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = await host(f);
  const old = await connect(f, id, 'host', f.owner.token);
  const c = await connect(f, id, 'controller', f.controller.token);
  await waitFor(() => c.messages.length === 1);
  const replacement = await connect(f, id, 'host', f.owner.token);
  assert.equal((await old.closed).code, 1008);
  assert.equal((await c.closed).code, 1008);
  assert.equal(replacement.messages.length, 0);
  const next = await connect(f, id, 'controller', f.controller.token);
  await waitFor(() => next.messages.length === 1);
  await f.revoke(f.owner.deviceId);
  next.socket.send(JSON.stringify({ type: 'frame', body: { mustNotArrive: true } }));
  assert.equal((await next.closed).code, 1008);
  assert.equal((await replacement.closed).code, 1008);
  assert.equal(replacement.messages.filter((m) => m.type === 'frame').length, 0);
});

test('relay enforces the controller count and frame rate independently of HTTP rate limits', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = await host(f);
  await connect(f, id, 'host', f.owner.token);
  const clients = [];
  for (let i = 0; i < 8; i++) {
    const c = await connect(f, id, 'controller', f.controller.token);
    await waitFor(() => c.messages.length === 1);
    clients.push(c);
  }
  assert.equal((await (await connect(f, id, 'controller', f.controller.token)).closed).code, 1008);
  for (let i = 0; i < 31; i++) clients[0].socket.send(JSON.stringify({ type: 'frame', body: { seq: i } }));
  assert.equal((await clients[0].closed).code, 1008);
});

test('ordinary sync sockets retain their original incoming byte cap and hint shape', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const vaults = await f.call('GET', '/v1/vaults', f.owner.token);
  let vaultId = vaults.body.vaults[0]?.id;
  if (!vaultId) {
    const made = await f.call('POST', '/v1/vaults', f.owner.token, { name: 'Test vault' });
    assert.equal(made.status, 201);
    vaultId = made.body.id;
  }
  const messages: Record<string, unknown>[] = [];
  const socket = new WebSocket(`${f.url.replace('http:', 'ws:')}/v1/sync/events?vaultId=${vaultId}`, {
    headers: { authorization: `Bearer ${f.owner.token}` },
  });
  socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  await waitFor(() => messages.length > 0);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['cursor', 'type', 'vaultId']);
  assert.equal(messages[0].type, 'vaultChanged');
  socket.send('x'.repeat(64 * 1024 + 1));
  assert.equal(await closed, 1009);
});

test('self-hosted relay host limit is configurable without a licence', async (t) => {
  const s = await startTestServer({ AGENT_RELAY_HOST_LIMIT: '1' });
  t.after(() => s.close());
  const a = await register(s, 'limit@example.test');
  const capabilities = await api(s, 'GET', '/v1/agents/capabilities', { token: a.accessToken });
  assert.equal(capabilities.body.canConnect, true);
  assert.equal(capabilities.body.hostLimit, 1);
  assert.equal(
    (
      await api(s, 'POST', '/v1/agents/hosts', {
        token: a.accessToken,
        body: { clientId: randomUUID(), label: 'One' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(s, 'POST', '/v1/agents/hosts', {
        token: a.accessToken,
        body: { clientId: randomUUID(), label: 'Two' },
      })
    ).status,
    409,
  );
});

test('a new session can reclaim a stale client ID only with a new routing ID and fresh pairing', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const clientId = randomUUID();
  const registered = await f.call('POST', '/v1/agents/hosts', f.owner.token, {
    clientId,
    label: 'Old session',
  });
  assert.equal(registered.status, 200);
  const h = await connect(f, registered.body.id, 'host', f.owner.token);
  const c = await connect(f, registered.body.id, 'controller', f.controller.token);
  await waitFor(() => c.messages.length === 1);
  await f.revoke(f.owner.deviceId);
  const renewed = await f.call('POST', '/v1/agents/hosts', f.controller.token, {
    clientId,
    label: 'New session',
  });
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.body.id, registered.body.id);
  assert.equal((await h.closed).code, 1008);
  assert.equal((await c.closed).code, 1008);
  assert.deepEqual((await f.call('GET', '/v1/agents/hosts', f.controller.token)).body, {
    hosts: [{ id: renewed.body.id, label: 'New session', online: false }],
  });
  const replay = await connect(f, registered.body.id, 'host', f.controller.token);
  assert.equal((await replay.closed).code, 1008);
});
