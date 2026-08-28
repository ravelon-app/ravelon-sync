import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  api,
  login,
  register,
  startTestServer,
  syncItem,
  type TestAccount,
  type TestServer,
} from './helpers.js';

describe('administration', () => {
  let server: TestServer;
  let admin: TestAccount;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer();
    admin = await register(server, 'admin@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Ravelon Sync Test', registrationMode: 'open' },
    });
    user = await register(server, 'member@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('a non-administrator is refused everywhere in the admin API', async () => {
    for (const [method, path] of [
      ['GET', '/v1/admin/overview'],
      ['GET', '/v1/admin/users'],
      ['GET', '/v1/admin/audit'],
      ['GET', '/v1/admin/settings'],
      ['GET', '/v1/admin/system'],
      ['GET', '/v1/admin/vaults'],
      ['GET', '/v1/admin/invites'],
    ] as const) {
      const response = await api(server, method, path, { token: user.accessToken });
      assert.equal(response.status, 403, `${method} ${path} should be refused`);
      assert.equal(response.body.error.code, 'admin_required');
    }
  });

  test('the overview counts what the deployment holds', async () => {
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId: 'member-vault', items: [syncItem('h1', 'member-vault')] },
    });
    const response = await api(server, 'GET', '/v1/admin/overview', { token: admin.accessToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.users.total, 2);
    assert.equal(response.body.users.admins, 1);
    assert.ok(response.body.syncItems >= 1);
    assert.ok(response.body.encryptedBytes > 0);
  });

  test('users can be listed, searched and filtered', async () => {
    const all = await api(server, 'GET', '/v1/admin/users', { token: admin.accessToken });
    assert.equal(all.body.total, 2);

    const searched = await api(server, 'GET', '/v1/admin/users?search=member', { token: admin.accessToken });
    assert.equal(searched.body.users.length, 1);
    assert.equal(searched.body.users[0].email, 'member@example.com');

    const admins = await api(server, 'GET', '/v1/admin/users?role=admin', { token: admin.accessToken });
    assert.equal(admins.body.users.length, 1);
    // A listing must never leak the hash, even to an administrator.
    assert.equal(admins.body.users[0].password_hash, undefined);
    assert.equal(admins.body.users[0].passwordHash, undefined);
  });

  test('disabling an account ends its sessions immediately', async () => {
    const session = await login(server, 'member@example.com', user.password);
    assert.equal(session.status, 200);

    const disabled = await api(server, 'PATCH', `/v1/admin/users/${user.userId}`, {
      token: admin.accessToken,
      body: { disabled: true, disabledReason: 'Left the company' },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.disabled, true);

    const stillSyncing = await api(server, 'GET', '/v1/account/me', { token: session.body.accessToken });
    assert.equal(stillSyncing.status, 403);
    assert.equal(stillSyncing.body.error.code, 'account_disabled');

    const signIn = await login(server, 'member@example.com', user.password);
    assert.equal(signIn.status, 403);

    await api(server, 'PATCH', `/v1/admin/users/${user.userId}`, {
      token: admin.accessToken,
      body: { disabled: false },
    });
  });

  test('the last administrator cannot be demoted, disabled or deleted', async () => {
    const demote = await api(server, 'PATCH', `/v1/admin/users/${admin.userId}`, {
      token: admin.accessToken,
      body: { role: 'user' },
    });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error.code, 'last_admin');

    const disable = await api(server, 'PATCH', `/v1/admin/users/${admin.userId}`, {
      token: admin.accessToken,
      body: { disabled: true },
    });
    assert.equal(disable.status, 409);

    const remove = await api(server, 'DELETE', `/v1/admin/users/${admin.userId}`, {
      token: admin.accessToken,
    });
    assert.equal(remove.status, 409);
  });

  test('an administrator can set a password when there is no mail to send', async () => {
    const response = await api(server, 'POST', `/v1/admin/users/${user.userId}/password`, {
      token: admin.accessToken,
      body: { newPassword: 'an-operator-issued-password' },
    });
    assert.equal(response.status, 200);

    const signIn = await login(server, 'member@example.com', 'an-operator-issued-password');
    assert.equal(signIn.status, 200);

    // The old password must stop working, or a reset achieves nothing.
    const oldPassword = await login(server, 'member@example.com', user.password);
    assert.equal(oldPassword.status, 401);
  });

  test('the vault listing shows metadata and never ciphertext', async () => {
    const response = await api(server, 'GET', '/v1/admin/vaults', { token: admin.accessToken });
    assert.equal(response.status, 200);
    assert.ok(response.body.vaults.length > 0);
    const vault = response.body.vaults[0];
    assert.ok('items' in vault);
    assert.ok('storageBytes' in vault);
    // An operator can see that records exist, never what is in them.
    assert.equal(vault.ciphertext, undefined);
    assert.equal(vault.blob, undefined);
    assert.equal(JSON.stringify(response.body).includes('b64:'), false);
  });

  test('security-relevant actions land in the audit log', async () => {
    const response = await api(server, 'GET', '/v1/admin/audit?limit=200', { token: admin.accessToken });
    assert.equal(response.status, 200);
    const actions = new Set(response.body.entries.map((entry: any) => entry.action));
    for (const expected of ['auth.register', 'admin.user_update', 'admin.password_set', 'sync.push']) {
      assert.ok(actions.has(expected), `expected ${expected} in the audit log`);
    }
    // The detail column is the operator's record, so it must stay free of
    // anything the operator is not otherwise entitled to see.
    assert.equal(JSON.stringify(response.body).includes('an-operator-issued-password'), false);
  });

  test('settings never return the stored SMTP password', async () => {
    await api(server, 'PUT', '/v1/admin/settings/smtp', {
      token: admin.accessToken,
      body: {
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
        user: 'mailer',
        password: 'super-secret-smtp-password',
        from: 'Ravelon Sync <sync@example.com>',
      },
    });

    const response = await api(server, 'GET', '/v1/admin/settings', { token: admin.accessToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.smtp.host, 'smtp.example.com');
    assert.equal(response.body.smtp.passwordSet, true);
    assert.equal(response.body.smtp.passwordEncrypted, undefined);
    assert.equal(JSON.stringify(response.body).includes('super-secret-smtp-password'), false);

    // It is encrypted at rest too, not just hidden from the response.
    const row = await server.db.prepare("SELECT value_json FROM settings WHERE key = 'smtp'")
      .get<{ value_json: string }>();
    assert.ok(row);
    assert.equal(row.value_json.includes('super-secret-smtp-password'), false);
  });

  test('saving other SMTP fields keeps the stored password', async () => {
    await api(server, 'PUT', '/v1/admin/settings/smtp', {
      token: admin.accessToken,
      body: {
        enabled: true,
        host: 'smtp2.example.com',
        port: 465,
        security: 'tls',
        user: 'mailer',
        from: 'Ravelon Sync <sync@example.com>',
      },
    });
    const response = await api(server, 'GET', '/v1/admin/settings', { token: admin.accessToken });
    assert.equal(response.body.smtp.host, 'smtp2.example.com');
    assert.equal(response.body.smtp.passwordSet, true);
  });

  test('maintenance mode refuses writes but keeps reads and sign-in up', async () => {
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: {
        serverName: 'Ravelon Sync Test',
        registrationMode: 'open',
        maintenanceMode: true,
        maintenanceMessage: 'Upgrading storage',
      },
    });

    const push = await api(server, 'POST', '/v1/sync/push', {
      token: admin.accessToken,
      body: { vaultId: 'admin-vault', items: [syncItem('blocked', 'admin-vault')] },
    });
    assert.equal(push.status, 503);
    assert.equal(push.body.error.code, 'maintenance_mode');
    assert.equal(push.body.error.message, 'Upgrading storage');

    // Reading and signing in stay up, so a person sees the notice rather than
    // a blank failure they cannot interpret.
    const pull = await api(server, 'GET', '/v1/sync/pull?vaultId=member-vault&cursor=0', {
      token: admin.accessToken,
    });
    assert.notEqual(pull.status, 503);
    const signIn = await login(server, 'admin@example.com', admin.password);
    assert.equal(signIn.status, 200);

    const config = await api(server, 'GET', '/v1/public-config');
    assert.equal(config.body.maintenanceMode, true);
    assert.equal(config.body.maintenanceMessage, 'Upgrading storage');

    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Ravelon Sync Test', registrationMode: 'open', maintenanceMode: false },
    });
  });

  test('system health names the things an operator must fix', async () => {
    const response = await api(server, 'GET', '/v1/admin/system', { token: admin.accessToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.database, 'sqlite');
    assert.ok(Array.isArray(response.body.warnings));
    assert.ok(response.body.warnings.some((warning: string) => warning.includes('NODE_ENV')));
  });
});

describe('server discovery', () => {
  test('health identifies the deployment as self-hosted with no licence', async () => {
    const server = await startTestServer();
    const response = await api(server, 'GET', '/v1/health');
    assert.equal(response.status, 200);
    // The Ravelon desktop client reads exactly these two fields before it will
    // add a server. `officialBuild: false` is what tells it not to look for a
    // licence at all.
    assert.equal(response.body.officialBuild, false);
    assert.equal(response.body.licenseStatus, 'self-hosted');
    assert.ok(response.body.capabilities.includes('granularSync'));
    await server.close();
  });

  test('public config reports a fresh deployment as needing setup', async () => {
    const server = await startTestServer();
    const before = await api(server, 'GET', '/v1/public-config');
    assert.equal(before.body.needsSetup, true);
    assert.equal(before.body.registrationOpen, true);

    await register(server, 'admin@example.com');

    const after = await api(server, 'GET', '/v1/public-config');
    assert.equal(after.body.needsSetup, false);
    assert.equal(after.body.registrationOpen, false);
    await server.close();
  });

  test('an unknown API path answers with JSON, not the web interface', async () => {
    const server = await startTestServer();
    const response = await api(server, 'GET', '/v1/does-not-exist');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'not_found');
    await server.close();
  });
});
