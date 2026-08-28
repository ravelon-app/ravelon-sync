import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { api, login, register, startTestServer, syncItem, type TestServer } from './helpers.js';

describe('account deletion', () => {
  let server: TestServer;
  const password = 'correct-horse-battery-staple';

  before(async () => {
    server = await startTestServer();
    const admin = await register(server, 'admin@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
  });

  after(async () => {
    await server.close();
  });

  test('deleting needs the password, not just a live session', async () => {
    const user = await register(server, 'leaving@example.com');

    const noProof = await api(server, 'DELETE', '/v1/account', { token: user.accessToken, body: {} });
    assert.equal(noProof.status, 400);
    assert.equal(noProof.body.error.code, 'reauthentication_required');

    const wrongPassword = await api(server, 'DELETE', '/v1/account', {
      token: user.accessToken,
      body: { password: 'not-the-password' },
    });
    assert.equal(wrongPassword.status, 401);

    // The account has to still be there after two refused attempts.
    const stillHere = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
    assert.equal(stillHere.status, 200);
  });

  test('deleting removes the account and every encrypted record with it', async () => {
    const user = await register(server, 'goodbye@example.com');
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId: 'goodbye-vault', items: [syncItem('host', 'goodbye-vault')] },
    });

    const deleted = await api(server, 'DELETE', '/v1/account', {
      token: user.accessToken,
      body: { password },
    });
    assert.equal(deleted.status, 204);

    const signIn = await login(server, 'goodbye@example.com', password);
    assert.equal(signIn.status, 401);

    // Cascades have to actually run, or a deleted account leaves its
    // ciphertext on a server nobody can reach it from.
    const items = await server.db.prepare('SELECT COUNT(*) AS count FROM sync_items WHERE vault_id = ?')
      .get<{ count: number }>('goodbye-vault');
    assert.equal(Number(items?.count ?? 0), 0);
    const vaults = await server.db.prepare('SELECT COUNT(*) AS count FROM vaults WHERE id = ?')
      .get<{ count: number }>('goodbye-vault');
    assert.equal(Number(vaults?.count ?? 0), 0);
  });

  test('the last administrator cannot delete themselves out of the server', async () => {
    const solo = await startTestServer();
    const admin = await register(solo, 'only-admin@example.com');
    const response = await api(solo, 'DELETE', '/v1/account', {
      token: admin.accessToken,
      body: { password },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'last_admin');
    await solo.close();
  });

  test('an export carries the account and its ciphertext, and says so', async () => {
    const user = await register(server, 'exporter@example.com');
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId: 'export-vault', items: [syncItem('host', 'export-vault')] },
    });

    const response = await api(server, 'GET', '/v1/account/export', { token: user.accessToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.email, 'exporter@example.com');
    assert.equal(response.body.encryptedItems.length, 1);
    // An export must never carry the password hash out of the server.
    assert.equal(response.body.user.password_hash, undefined);
    assert.equal(JSON.stringify(response.body).includes('scrypt:'), false);
  });
});

describe('storage quota', () => {
  test('a vault stops accepting records once it is full', async () => {
    // 1 MB, so the limit is reachable without pushing a realistic vault.
    const server = await startTestServer({ VAULT_STORAGE_LIMIT_MB: '1' });
    const user = await register(server, 'filler@example.com');
    const vaultId = 'full-vault';

    // Roughly 64 KB of ciphertext per record, counted twice because a version
    // row is kept alongside it.
    const large = `b64:${'QUJDRA'.repeat(11_000)}`;
    let rejected = false;

    for (let round = 0; round < 20 && !rejected; round += 1) {
      const response = await api(server, 'POST', '/v1/sync/push', {
        token: user.accessToken,
        body: {
          vaultId,
          items: [syncItem(`bulk-${round}`, vaultId, { ciphertext: large })],
        },
      });
      if (response.status === 413) {
        assert.equal(response.body.error.code, 'vault_storage_quota_reached');
        rejected = true;
      } else {
        assert.equal(response.status, 200, JSON.stringify(response.body));
      }
    }

    assert.ok(rejected, 'the quota should have refused a push before 20 rounds');
    await server.close();
  });

  test('the account limit on vaults is enforced', async () => {
    const server = await startTestServer({ VAULTS_PER_USER: '2' });
    const user = await register(server, 'collector@example.com');

    // Registration already created the personal vault, so one more fits.
    const second = await api(server, 'POST', '/v1/vaults', {
      token: user.accessToken,
      body: { name: 'Second' },
    });
    assert.equal(second.status, 201);

    const third = await api(server, 'POST', '/v1/vaults', {
      token: user.accessToken,
      body: { name: 'Third' },
    });
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'vault_limit_reached');
    await server.close();
  });
});
