import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  api,
  fakeCiphertext,
  fakeNonce,
  register,
  startTestServer,
  syncItem,
  type TestAccount,
  type TestServer,
} from './helpers.js';

describe('encrypted sync', () => {
  let server: TestServer;
  let user: TestAccount;
  const vaultId = 'personal-vault';

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'sync@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('a push adopts the vault id the client chose', async () => {
    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('host-1', vaultId)] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].status, 'stored');
    assert.ok(Number(response.body.results[0].revision) > 0);
    assert.equal(response.body.cursor, String(response.body.results[0].revision));
  });

  test('a pull returns the record with its ciphertext untouched', async () => {
    const response = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 1);
    const item = response.body.items[0];
    assert.equal(item.id, 'host-1');
    assert.equal(item.itemType, 'Host');
    // Byte-for-byte what the client sent. The server is not allowed to
    // normalise, re-encode or otherwise touch a record it cannot read.
    assert.equal(item.ciphertext, fakeCiphertext('host-1'));
    assert.equal(item.nonce, fakeNonce('host-1'));
    assert.equal(item.hasMore, undefined);
    assert.equal(response.body.hasMore, false);
  });

  test('a cursor only returns what came after it', async () => {
    const first = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    const cursor = first.body.cursor;

    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('host-2', vaultId)] },
    });

    const next = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=${cursor}`, {
      token: user.accessToken,
    });
    assert.equal(next.body.items.length, 1);
    assert.equal(next.body.items[0].id, 'host-2');
  });

  test('an identical push is acknowledged without writing again', async () => {
    const before = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    const beforeCursor = before.body.cursor;

    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('host-1', vaultId)] },
    });
    assert.equal(response.body.results[0].status, 'unchanged');
    assert.equal(response.body.cursor, beforeCursor);
  });

  test('an older last-writer-wins push is reported stale', async () => {
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('host-3', vaultId, { clientRevision: 5 })] },
    });
    const stale = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('host-3', vaultId, { clientRevision: 2 })] },
    });
    assert.equal(stale.body.results[0].status, 'stale');
  });

  test('a compare-and-swap mismatch returns the server version to merge against', async () => {
    const created = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [syncItem('host-4', vaultId, { baseRevision: 0, clientRevision: 1 })],
      },
    });
    const revision = created.body.results[0].revision;

    const conflict = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [
          syncItem('host-4', vaultId, {
            baseRevision: revision - 1,
            clientRevision: 2,
            ciphertext: fakeCiphertext('host-4-other'),
          }),
        ],
      },
    });
    assert.equal(conflict.body.results[0].status, 'conflict');
    assert.equal(conflict.body.results[0].revision, revision);
    // The client cannot merge without the current record, and the server
    // cannot merge at all, so the current record has to come back.
    assert.ok(conflict.body.results[0].current);
    assert.equal(conflict.body.results[0].current.ciphertext, fakeCiphertext('host-4'));
  });

  test('a compare-and-swap push against the right base succeeds', async () => {
    const current = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    const host4 = current.body.items.find((item: any) => item.id === 'host-4');

    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [
          syncItem('host-4', vaultId, {
            baseRevision: host4.revision,
            clientRevision: 2,
            ciphertext: fakeCiphertext('host-4-v2'),
          }),
        ],
      },
    });
    assert.equal(response.body.results[0].status, 'stored');
  });

  test('a delete stays as a tombstone so other devices learn about it', async () => {
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [
          syncItem('host-2', vaultId, {
            clientRevision: 9,
            deletedAt: '2026-02-01T12:00:00.000Z',
          }),
        ],
      },
    });
    const pulled = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    const tombstone = pulled.body.items.find((item: any) => item.id === 'host-2');
    assert.ok(tombstone, 'the record must still be delivered, not simply disappear');
    assert.equal(tombstone.deletedAt, '2026-02-01T12:00:00.000Z');
  });

  test('plaintext is refused rather than stored', async () => {
    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [
          syncItem('leak', vaultId, {
            ciphertext: JSON.stringify({ hostname: 'db.internal', password: 'hunter2' }),
          }),
        ],
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'plaintext_sync_payload');
  });

  test('base64-wrapped plaintext is refused too', async () => {
    const encoded = Buffer.from(JSON.stringify({ username: 'root', password: 'hunter2' })).toString('base64');
    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('leak-b64', vaultId, { ciphertext: `b64:${encoded}` })] },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'plaintext_sync_payload');
  });

  test('an unknown record type is refused', async () => {
    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('odd', vaultId, { itemType: 'CreditCard' })] },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_item_type');
  });

  test('an item that names a different vault than the request is refused', async () => {
    const response = await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('mismatched', 'some-other-vault')] },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'vault_mismatch');
  });

  test('another account cannot read or take over the vault', async () => {
    const admin = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
    assert.equal(admin.status, 200);

    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: user.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
    const stranger = await register(server, 'stranger@example.com');

    const pull = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: stranger.accessToken,
    });
    assert.equal(pull.status, 403);
    assert.equal(pull.body.error.code, 'vault_not_accessible');

    // Pushing to an id somebody else already owns must not silently create a
    // second vault, and must not join the existing one either.
    const push = await api(server, 'POST', '/v1/sync/push', {
      token: stranger.accessToken,
      body: { vaultId, items: [syncItem('intruder', vaultId)] },
    });
    assert.equal(push.status, 403);
    assert.equal(push.body.error.code, 'vault_not_accessible');
  });

  test('paging walks the whole vault exactly once', async () => {
    const server2 = await startTestServer();
    const owner = await register(server2, 'pager@example.com');
    const pagedVault = 'paging-vault';

    const items = Array.from({ length: 250 }, (_, index) => syncItem(`item-${index}`, pagedVault));
    for (let offset = 0; offset < items.length; offset += 100) {
      const response = await api(server2, 'POST', '/v1/sync/push', {
        token: owner.accessToken,
        body: { vaultId: pagedVault, items: items.slice(offset, offset + 100) },
      });
      assert.equal(response.status, 200);
    }

    const seen = new Set<string>();
    let cursor = '0';
    for (let page = 0; page < 10; page += 1) {
      const response = await api(server2, 'GET', `/v1/sync/pull?vaultId=${pagedVault}&cursor=${cursor}`, {
        token: owner.accessToken,
      });
      for (const item of response.body.items) {
        assert.ok(!seen.has(item.id), `${item.id} was delivered twice`);
        seen.add(item.id);
      }
      cursor = response.body.cursor;
      if (!response.body.hasMore) break;
    }
    assert.equal(seen.size, 250);
    await server2.close();
  });
});

describe('vault key material', () => {
  let server: TestServer;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'keys@example.com');
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId: 'kv', items: [syncItem('seed', 'kv')] },
    });
  });

  after(async () => {
    await server.close();
  });

  test('wrapped key material round-trips unchanged', async () => {
    const material = {
      version: 1,
      wrappedVaultKey: 'b64:d3JhcHBlZC1rZXktbWF0ZXJpYWw',
      kdf: { name: 'argon2id', salt: 'b64:c2FsdA', iterations: 3 },
    };
    const stored = await api(server, 'PUT', '/v1/vault/key-material', {
      token: user.accessToken,
      body: { vaultId: 'kv', material },
    });
    assert.equal(stored.status, 200);

    const read = await api(server, 'GET', '/v1/vault/key-material?vaultId=kv', {
      token: user.accessToken,
    });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.material, material);
  });

  test('a first device can ask to create the envelope only if none exists', async () => {
    const first = { version: 1, purpose: 'ravelon-account-key-v1', salt: 's', nonce: 'n1', ciphertext: 'c1' };
    const second = {
      version: 1,
      purpose: 'ravelon-account-key-v1',
      salt: 's',
      nonce: 'n2',
      ciphertext: 'c2',
    };
    // The personal vault exists from registration; a client-chosen id only
    // comes into being with the first push.
    const me = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
    const personal = me.body.vaults.find((vault: { kind: string }) => vault.kind === 'personal').id;
    const created = await api(server, 'PUT', '/v1/vault/key-material', {
      token: user.accessToken,
      body: { vaultId: personal, material: first, ifAbsent: true },
    });
    assert.equal(created.status, 200);
    const refused = await api(server, 'PUT', '/v1/vault/key-material', {
      token: user.accessToken,
      body: { vaultId: personal, material: second, ifAbsent: true },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'key_material_exists');
    const read = await api(server, 'GET', `/v1/vault/key-material?vaultId=${personal}`, {
      token: user.accessToken,
    });
    assert.deepEqual(read.body.material, first);
    // Without the flag a PUT still replaces, which re-sealing after a password change needs.
    const replaced = await api(server, 'PUT', '/v1/vault/key-material', {
      token: user.accessToken,
      body: { vaultId: personal, material: second },
    });
    assert.equal(replaced.status, 200);
  });
  test('an unwrapped secret is refused', async () => {
    const response = await api(server, 'PUT', '/v1/vault/key-material', {
      token: user.accessToken,
      body: { vaultId: 'kv', material: { version: 1, masterPassword: 'hunter2' } },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'raw_vault_key_material');
  });

  test('a nested unwrapped secret is refused too', async () => {
    const response = await api(server, 'PUT', '/v1/vault/key-material', {
      token: user.accessToken,
      body: { vaultId: 'kv', material: { version: 1, keys: [{ dek: 'raw-data-key' }] } },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'raw_vault_key_material');
  });
});

test('VNC TLS and Apple settings survive self-hosted encrypted sync', async () => {
  const server = await startTestServer();
  try {
    const user = await register(server, 'vnc-roundtrip@example.test');
    for (const security of ['x509', 'anonymousTls', 'apple']) {
      const host = {
        protocol: 'vnc',
        address: 'desktop.example.test',
        username: 'fixture-user',
        secret: 'synthetic-password',
        jumpHostId: 'ssh-gateway',
        vnc: {
          security,
          tlsServerName: 'desktop.example.test',
          caCertificate: 'public CA fixture',
          allowUnauthenticated: false,
        },
      };
      const key = randomBytes(32);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(host)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString('base64');
      const record = syncItem(`vnc-${security}`, 'vnc-vault', {
        ciphertext,
        nonce: nonce.toString('base64'),
      });
      const push = await api(server, 'POST', '/v1/sync/push', {
        token: user.accessToken,
        body: { vaultId: 'vnc-vault', items: [record] },
      });
      assert.equal(push.status, 200);
      const pull = await api(server, 'GET', '/v1/sync/pull?vaultId=vnc-vault&cursor=0', {
        token: user.accessToken,
      });
      assert.equal(pull.status, 200);
      const item = pull.body.items.find((entry: { id: string }) => entry.id === record.id);
      assert.equal(item.ciphertext, ciphertext);
      assert.equal(item.nonce, nonce.toString('base64'));
      assert.equal(JSON.stringify(item).includes(host.secret), false);
      assert.equal(JSON.stringify(item).includes(host.address), false);
      const bytes = Buffer.from(item.ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(item.nonce, 'base64'));
      decipher.setAuthTag(bytes.subarray(-16));
      assert.deepEqual(
        JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString()),
        host,
      );
    }
  } finally {
    await server.close();
  }
});
