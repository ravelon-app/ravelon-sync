import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import { AgentRelayHub } from '../src/lib/agent-relay.js';

/** The network boundary can stall writes and authorization independently. */
class WireSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closeCode = 0;
  closeReason = '';
  autoPong = true;
  send(value: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(value));
    callback?.();
  }
  close(code: number, reason: string) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.readyState = 3;
    this.emit('close');
  }
  ping() {
    if (this.autoPong) this.emit('pong');
  }
  frame(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
  asWebSocket() {
    return this as unknown as WebSocket;
  }
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('relay transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup(
  hostCheck: () => Promise<void> = async () => {},
  controllerCheck: () => Promise<void> = async () => {},
) {
  const hub = new AgentRelayHub(10);
  const id = randomUUID();
  const h = new WireSocket();
  const c = new WireSocket();
  hub.attach(h.asWebSocket(), id, 'host', { userId: 'account', deviceId: 'owner' }, hostCheck);
  hub.attach(c.asWebSocket(), id, 'controller', { userId: 'account', deviceId: 'phone' }, controllerCheck);
  return { hub, h, c, id, routeId: c.sent[0].routeId };
}

test('idle relay revocation and database failure close routes without a command', async (t) => {
  let denied = false;
  const s = setup(async () => {
    if (denied) throw new Error('database unavailable');
  });
  t.after(() => s.hub.close());
  denied = true;
  await waitFor(() => s.h.readyState === 3);
  assert.equal(s.h.closeCode, 1008);
  assert.equal(s.c.closeCode, 1008);
});
test('a peer that stops answering protocol pings loses its routes', async (t) => {
  const s = setup();
  t.after(() => s.hub.close());
  s.h.autoPong = false;
  await waitFor(() => s.h.readyState === 3);
  assert.equal(s.h.closeReason, 'heartbeat_timeout');
  assert.equal(s.c.readyState, 3);
});
test('revalidation blocks a frame already waiting on authorization after revocation', async (t) => {
  let release!: () => void;
  let checking = false;
  let revoked = false;
  const s = setup(async () => {
    checking = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (revoked) throw new Error('revoked');
  });
  t.after(() => s.hub.close());
  s.c.frame({ type: 'frame', body: { command: 'must not run' } });
  await waitFor(() => checking);
  revoked = true;
  release();
  await waitFor(() => s.c.readyState === 3);
  assert.equal(s.h.sent.filter((m) => m.type === 'frame').length, 0);
});
test('pending authorization cannot buffer an unbounded command stream', async (t) => {
  const s = setup(async () => new Promise(() => {}));
  t.after(() => s.hub.close());
  const value = { type: 'frame', body: { ciphertext: 'x'.repeat(800_000) } };
  s.c.frame(value);
  s.c.frame(value);
  s.c.frame(value);
  assert.equal(s.c.closeReason, 'backpressure');
  assert.equal(s.h.sent.filter((m) => m.type === 'frame').length, 0);
});
test('a slow destination closes instead of growing its send buffer', async (t) => {
  const s = setup();
  t.after(() => s.hub.close());
  s.h.bufferedAmount = 2 * 1024 * 1024;
  s.c.frame({ type: 'frame', body: { ciphertext: 'opaque' } });
  await waitFor(() => s.h.readyState === 3);
  assert.equal(s.h.closeReason, 'backpressure');
  assert.equal(s.c.readyState, 3);
});
test('byte rate limits apply even while each valid frame is drained', async (t) => {
  const s = setup();
  t.after(() => s.hub.close());
  for (let index = 0; index < 10; index++) {
    s.c.frame({ type: 'frame', body: { ciphertext: 'x'.repeat(900_000) } });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(s.c.closeReason, 'rate_limit');
  assert.equal(s.h.sent.filter((m) => m.type === 'frame').length, 9);
});
test('routing metadata counts toward the final encoded frame budget', async (t) => {
  const s = setup();
  t.after(() => s.hub.close());
  const frame = { type: 'frame', body: { ciphertext: '' } };
  const empty = Buffer.byteLength(JSON.stringify(frame));
  frame.body.ciphertext = 'x'.repeat(1024 * 1024 - empty);
  s.c.frame(frame);
  await waitFor(() => s.c.readyState === 3);
  assert.equal(s.c.closeCode, 1009);
  assert.equal(s.h.sent.filter((m) => m.type === 'frame').length, 0);
});
test('a host cannot address a controller belonging to a different host', async (t) => {
  const s = setup();
  t.after(() => s.hub.close());
  const otherId = randomUUID();
  const otherHost = new WireSocket();
  const otherController = new WireSocket();
  s.hub.attach(
    otherHost.asWebSocket(),
    otherId,
    'host',
    { userId: 'account', deviceId: 'other-host' },
    async () => {},
  );
  s.hub.attach(
    otherController.asWebSocket(),
    otherId,
    'controller',
    { userId: 'account', deviceId: 'other-phone' },
    async () => {},
  );
  s.h.frame({ type: 'frame', routeId: otherController.sent[0].routeId, body: { ciphertext: 'wrong route' } });
  await waitFor(() => s.h.readyState === 3);
  assert.equal(otherController.sent.length, 1);
  assert.equal(otherController.readyState, 1);
});
test('host deletion and server shutdown stop every live route', () => {
  const s = setup();
  s.hub.disconnectHost(s.id);
  assert.equal(s.h.readyState, 3);
  assert.equal(s.c.readyState, 3);
  assert.equal(s.hub.online(s.id), false);
  s.hub.close();
  const next = setup();
  next.hub.close();
  assert.equal(next.h.readyState, 3);
  assert.equal(next.c.readyState, 3);
});

test('an authorization query that never returns fails closed within its deadline', async (t) => {
  const hub = new AgentRelayHub(10, 20);
  t.after(() => hub.close());
  const host = new WireSocket();
  const client = new WireSocket();
  const id = randomUUID();
  hub.attach(
    host.asWebSocket(),
    id,
    'host',
    { userId: 'account', deviceId: 'host' },
    async () => new Promise(() => {}),
  );
  hub.attach(
    client.asWebSocket(),
    id,
    'controller',
    { userId: 'account', deviceId: 'phone' },
    async () => {},
  );
  client.frame({ type: 'frame', body: { ciphertext: 'must not arrive' } });
  await waitFor(() => client.readyState === 3);
  assert.equal(host.closeCode, 1008);
  assert.equal(host.sent.filter((m) => m.type === 'frame').length, 0);
});

test('a revoked controller cannot disconnect the host or another controller', async (t) => {
  let revoked = false;
  const s = setup(
    async () => {},
    async () => {
      if (revoked) throw new Error('revoked');
    },
  );
  t.after(() => s.hub.close());
  const other = new WireSocket();
  s.hub.attach(
    other.asWebSocket(),
    s.id,
    'controller',
    { userId: 'account', deviceId: 'other' },
    async () => {},
  );
  revoked = true;
  s.h.frame({ type: 'frame', routeId: s.routeId, body: { ciphertext: 'must not arrive' } });
  await waitFor(() => s.c.readyState === 3);
  assert.equal(s.h.readyState, 1);
  assert.equal(other.readyState, 1);
  assert.equal(s.c.sent.filter((m) => m.type === 'frame').length, 0);
});
