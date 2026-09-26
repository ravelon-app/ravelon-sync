import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { WebSocket } from 'ws';

import { MAX_SOCKETS_PER_USER } from '../src/lib/sync-events.js';
import {
  api,
  register,
  startTestServer,
  syncItem,
  type TestAccount,
  type TestServer,
} from './helpers.js';

/** Ciphertext of a given size that the plaintext guard accepts. */
function largeCiphertext(bytes: number): string {
  return randomBytes(bytes).toString('base64');
}

async function pullAll(server: TestServer, token: string, vaultId: string, from = 0) {
  const seen: string[] = [];
  const cursors: number[] = [];
  let cursor = from;
  let pages = 0;
  for (;;) {
    const response = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=${cursor}`, { token });
    assert.equal(response.status, 200);
    pages += 1;
    for (const item of response.body.items) seen.push(item.id);
    cursor = Number(response.body.cursor);
    cursors.push(cursor);
    if (!response.body.hasMore) break;
    assert.ok(pages < 100, 'pagination must terminate');
  }
  return { seen, cursor, pages, cursors };
}

async function openSocket(server: TestServer, vaultId: string, token: string) {
  const messages: unknown[] = [];
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  // Listeners go on before the upgrade completes: the server sends its first
  // message straight away, and one attached afterwards can miss it.
  const socket = await server.app.injectWS(
    `/v1/sync/events?vaultId=${encodeURIComponent(vaultId)}`,
    { headers: { authorization: `Bearer ${token}` } },
    {
      onInit: (ws) => {
        ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
        ws.once('close', (code: number, reason: Buffer) => resolveClosed({ code, reason: reason.toString() }));
      },
    },
  );
  return { socket, messages, closed };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('sync protocol', () => {
  let server: TestServer;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'protocol@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('pages are bounded by bytes, and every record still arrives exactly once', async () => {
    const vaultId = 'big-vault';
    // Fifteen records of about 700 KB: more than one 8 MiB page, far fewer
    // than the row limit, so only the byte budget can split them.
    const items = Array.from({ length: 15 }, (_, index) => syncItem(`big-${index}`, vaultId, {
      ciphertext: largeCiphertext(520 * 1024),
    }));
    const pushed = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items },
    });
    assert.equal(pushed.status, 200);

    const first = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.items.length > 0 && first.body.items.length < 15);

    const all = await pullAll(server, user.accessToken, vaultId);
    assert.deepEqual([...all.seen].sort(), items.map((item) => String(item.id)).sort());
    assert.equal(new Set(all.seen).size, all.seen.length);
    for (let index = 1; index < all.cursors.length; index += 1) {
      assert.ok(all.cursors[index] >= all.cursors[index - 1], 'cursor never moves backwards');
    }
    assert.equal(all.cursor, Number(pushed.body.cursor));
  });

  test('a final page reports the head, even below a cursor from an older database', async () => {
    const vaultId = 'rewound-vault';
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('r-1', vaultId)] },
    });
    const head = (await pullAll(server, user.accessToken, vaultId)).cursor;

    // A client that synced against a newer copy of the database holds a
    // cursor this one never reached. It must see the lower head to notice.
    const response = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=${head + 1000}`, {
      token: user.accessToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 0);
    assert.equal(Number(response.body.cursor), head);
  });

  test('a push based on a copy the server no longer has is stored, not an unresolvable conflict', async () => {
    const vaultId = 'restored-vault';
    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('lost-1', vaultId, { baseRevision: 57 })] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].status, 'stored');
    assert.ok(response.body.results[0].revision > 0);
  });

  test('a record re-encrypted under the same revision is stored, not reported unchanged', async () => {
    const vaultId = 'rekeyed-vault';
    const original = syncItem('k-1', vaultId);
    const first = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [original] },
    });
    const revision = first.body.results[0].revision;

    const rekeyed = { ...original, ciphertext: largeCiphertext(48), baseRevision: revision };
    const second = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [rekeyed] },
    });
    assert.equal(second.body.results[0].status, 'stored');

    const pulled = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    assert.equal(pulled.body.items[0].ciphertext, rekeyed.ciphertext);

    const again = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [{ ...rekeyed, baseRevision: second.body.results[0].revision }] },
    });
    assert.equal(again.body.results[0].status, 'unchanged');
  });

  test('two first pushes to a new vault id both succeed', async () => {
    const vaultId = 'raced-vault';
    const [left, right] = await Promise.all([
      api(server, 'POST', '/v1/sync/push', {
        token: user.accessToken,
        body: { vaultId, items: [syncItem('race-a', vaultId)] },
      }),
      api(server, 'POST', '/v1/sync/push', {
        token: user.accessToken,
        body: { vaultId, items: [syncItem('race-b', vaultId)] },
      }),
    ]);
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.equal(right.status, 200, JSON.stringify(right.body));
    const all = await pullAll(server, user.accessToken, vaultId);
    assert.deepEqual(all.seen.sort(), ['race-a', 'race-b']);
  });

  test('status and watch carry the granular cursor', async () => {
    const vaultId = 'watched-vault';
    const pushed = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('w-1', vaultId)] },
    });
    const status = await api(server, 'GET', `/v1/desktop/vault/status?vaultId=${vaultId}`, {
      token: user.accessToken,
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.exists, false);
    assert.equal(status.body.cursor, pushed.body.cursor);
  });

  test('watch with afterCursor answers at once when the caller is behind', async () => {
    const vaultId = 'watched-vault';
    const started = Date.now();
    const response = await api(server, 'GET', `/v1/desktop/vault/watch?vaultId=${vaultId}&afterVersion=0&afterCursor=0`, {
      token: user.accessToken,
    });
    assert.equal(response.status, 200);
    assert.notEqual(response.body.cursor, '0');
    assert.ok(Date.now() - started < 2000);
  });

  test('watch with afterCursor waits while current, then wakes on a push', async () => {
    const vaultId = 'watched-vault';
    const status = await api(server, 'GET', `/v1/desktop/vault/status?vaultId=${vaultId}`, {
      token: user.accessToken,
    });
    // The legacy comparison alone would answer instantly here: this vault has
    // no snapshot, and the cursor sent as `afterVersion` is not 0.
    const started = Date.now();
    const waiting = api(
      server,
      'GET',
      `/v1/desktop/vault/watch?vaultId=${vaultId}&afterVersion=${status.body.cursor}&afterCursor=${status.body.cursor}`,
      { token: user.accessToken },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pushed = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('w-2', vaultId)] },
    });
    const response = await waiting;
    assert.ok(Date.now() - started >= 100, 'the request was held until the change');
    assert.ok(Date.now() - started < 5000, 'and answered on the event, not the timeout');
    assert.equal(response.body.cursor, pushed.body.cursor);
  });

  test('the first personal vault cannot be deleted, another one can', async () => {
    const me = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
    const personal = me.body.vaults.find((vault: { kind: string }) => vault.kind === 'personal');
    const refused = await api(server, 'DELETE', `/v1/vaults/${personal.id}`, { token: user.accessToken });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'personal_vault_required');

    const created = await api(server, 'POST', '/v1/vaults', {
      token: user.accessToken,
      body: { name: 'Scratch', kind: 'personal' },
    });
    assert.equal(created.status, 201);
    const removed = await api(server, 'DELETE', `/v1/vaults/${created.body.id}`, { token: user.accessToken });
    assert.equal(removed.status, 204);
  });

  test('a restored version outranks the copy it replaces', async () => {
    const vaultId = 'history-vault';
    const first = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('h-1', vaultId, { clientRevision: 5 })] },
    });
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [syncItem('h-1', vaultId, {
          clientRevision: 9,
          ciphertext: largeCiphertext(48),
          baseRevision: first.body.results[0].revision,
        })],
      },
    });
    const versions = await api(server, 'GET', `/v1/vaults/${vaultId}/items/h-1/versions`, {
      token: user.accessToken,
    });
    const oldest = versions.body.versions.at(-1);
    const restored = await api(server, 'POST', `/v1/vaults/${vaultId}/items/h-1/restore`, {
      token: user.accessToken,
      body: { versionId: oldest.id },
    });
    assert.equal(restored.status, 200);
    assert.ok(restored.body.item.clientRevision > 9);

    // A device still holding revision 9 and pushing last-writer-wins style
    // must not silently undo the restore.
    const stale = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('h-1', vaultId, { clientRevision: 9, ciphertext: largeCiphertext(48) })] },
    });
    assert.equal(stale.body.results[0].status, 'stale');
  });
});

describe('sync event sockets', () => {
  let server: TestServer;
  let owner: TestAccount;

  before(async () => {
    server = await startTestServer();
    owner = await register(server, 'events-owner@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('a bad token closes with the reason clients treat as "refresh and retry"', async () => {
    const { closed } = await openSocket(server, 'personal-vault', 'not-a-real-token');
    const result = await closed;
    assert.equal(result.code, 1008);
    assert.equal(result.reason, 'unauthorized');
  });

  test('a signed-out device loses its socket at the next heartbeat', async () => {
    const vaultId = 'socket-vault';
    await api(server, 'POST', '/v1/sync/push', {
      token: owner.accessToken,
      body: { vaultId, items: [syncItem('s-1', vaultId)] },
    });
    const device = await register(server, 'events-second@example.com').catch(() => null);
    assert.equal(device, null, 'registration is closed after the first account');

    const login = await api(server, 'POST', '/v1/auth/login', {
      body: {
        email: owner.email,
        password: owner.password,
        deviceName: 'Laptop',
        platform: 'test',
        mfaSupported: true,
      },
    });
    const { socket, messages, closed } = await openSocket(server, vaultId, login.body.accessToken);
    await waitFor(() => messages.length > 0);

    await server.syncEvents.sweep();
    assert.equal(socket.readyState, socket.OPEN, 'a live device keeps its socket');

    await api(server, 'POST', '/v1/auth/logout', {
      token: login.body.accessToken,
      body: { refreshToken: login.body.refreshToken },
    });
    await server.syncEvents.sweep();
    const result = await closed;
    assert.equal(result.code, 1008);
    assert.equal(result.reason, 'unauthorized');
  });

  test('a member removed from a vault stops hearing about it', async () => {
    const invite = await api(server, 'POST', '/v1/admin/invites', {
      token: owner.accessToken,
      body: { email: 'events-member@example.com' },
    });
    assert.ok(invite.status === 200 || invite.status === 201, JSON.stringify(invite.body));
    const inviteToken = String(invite.body.token);
    const member = await register(server, 'events-member@example.com', { inviteToken });

    const team = await api(server, 'POST', '/v1/teams', {
      token: owner.accessToken,
      body: { name: 'Ops' },
    });
    assert.equal(team.status, 201, JSON.stringify(team.body));
    const teamVault = team.body.vaults[0].id;
    const teamInvite = await api(server, 'POST', `/v1/teams/${team.body.id}/invites`, {
      token: owner.accessToken,
      body: { email: member.email, role: 'member', vaultRole: 'editor' },
    });
    assert.equal(teamInvite.status, 201, JSON.stringify(teamInvite.body));
    const teamToken = String(teamInvite.body.token);
    const accepted = await api(server, 'POST', `/v1/team-invites/${encodeURIComponent(teamToken)}/accept`, {
      token: member.accessToken,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    const { socket, messages, closed } = await openSocket(server, teamVault, member.accessToken);
    await waitFor(() => messages.length > 0);
    await server.syncEvents.sweep();
    assert.equal(socket.readyState, socket.OPEN);

    const removed = await api(server, 'DELETE', `/v1/teams/${team.body.id}/members/${member.userId}`, {
      token: owner.accessToken,
    });
    assert.ok(removed.status === 200 || removed.status === 204, JSON.stringify(removed.body));
    await server.syncEvents.sweep();
    const result = await closed;
    assert.equal(result.code, 1008);
    assert.equal(result.reason, 'vault_not_accessible');
  });

  test('one account cannot hold unbounded sockets', async () => {
    const vaultId = 'many-sockets-vault';
    await api(server, 'POST', '/v1/sync/push', {
      token: owner.accessToken,
      body: { vaultId, items: [syncItem('m-1', vaultId)] },
    });
    assert.equal(server.syncEvents.socketsFor(owner.userId), 0, 'closed sockets are not counted');
    const sockets: WebSocket[] = [];
    for (let index = 0; index < MAX_SOCKETS_PER_USER; index += 1) {
      const opened = await openSocket(server, vaultId, owner.accessToken);
      await waitFor(() => opened.messages.length > 0).catch((error) => { throw new Error(`socket ${index}: ${error}`); });
      sockets.push(opened.socket);
    }
    const extra = await openSocket(server, vaultId, owner.accessToken);
    const result = await extra.closed;
    assert.equal(result.code, 1013);
    for (const socket of sockets) socket.terminate();
  });
});

describe('pairing approval', () => {
  let server: TestServer;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer({ RATE_LIMIT_DISABLED: '0', RATE_LIMIT_AUTH_FAILURES: '3' });
    user = await register(server, 'pair-lock@example.com');
    await api(server, 'PATCH', '/v1/account', {
      token: user.accessToken,
      body: { displayName: 'Pat Pairing' },
    });
  });

  after(async () => {
    await server.close();
  });

  test('repeated wrong passwords lock approval, even with the right one', async () => {
    const started = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Laptop', platform: 'desktop' },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await api(server, 'POST', '/v1/desktop-auth/approve', {
        token: user.accessToken,
        body: { requestId: started.body.requestId, password: 'not-the-password' },
      });
      assert.equal(wrong.status, 401);
    }
    const locked = await api(server, 'POST', '/v1/desktop-auth/approve', {
      token: user.accessToken,
      body: { requestId: started.body.requestId, password: user.password },
    });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'too_many_attempts');
  });

  test('a browser-paired client receives the display name with its session', async () => {
    const fresh = await startTestServer();
    try {
      const account = await register(fresh, 'pair-name@example.com');
      await api(fresh, 'PATCH', '/v1/account', {
        token: account.accessToken,
        body: { displayName: 'Pat Pairing' },
      });
      const started = await api(fresh, 'POST', '/v1/desktop-auth/start', {
        body: { deviceName: 'Laptop', platform: 'desktop' },
      });
      await api(fresh, 'POST', '/v1/desktop-auth/approve', {
        token: account.accessToken,
        body: { requestId: started.body.requestId, password: account.password },
      });
      const exchanged = await api(fresh, 'POST', '/v1/desktop-auth/exchange', {
        body: { requestId: started.body.requestId, pollToken: started.body.pollToken },
      });
      assert.equal(exchanged.status, 200);
      assert.equal(exchanged.body.user.displayName, 'Pat Pairing');
      assert.equal(exchanged.body.user.email, account.email);
    } finally {
      await fresh.close();
    }
  });
});

describe('hosted-only client features', () => {
  let server: TestServer;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'client-compat@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('push registration is answered, and says nothing was registered', async () => {
    const body = { token: 'abc123', platform: 'ios', environment: 'production', topic: 'app.ravelon.ios' };
    const anonymous = await api(server, 'POST', '/v1/push/devices', { body });
    assert.equal(anonymous.status, 401);
    const response = await api(server, 'POST', '/v1/push/devices', { token: user.accessToken, body });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { registered: false });
  });

  test('usage counters are reported as switched off, and forgetting succeeds', async () => {
    const config = await api(server, 'GET', '/v1/telemetry/ios/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.enabled, false);
    const forget = await api(server, 'POST', '/v1/telemetry/ios/forget', { body: { installId: 'install-1' } });
    assert.equal(forget.status, 200);
    // Uploads stay unanswered: nothing here would ever store them.
    const upload = await api(server, 'POST', '/v1/telemetry/ios', { body: { installId: 'install-1' } });
    assert.equal(upload.status, 404);
  });
});
