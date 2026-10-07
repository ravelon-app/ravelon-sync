import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { totpCodeAtStep } from '../src/auth/totp.js';
import { api, register, startTestServer, type TestAccount, type TestServer } from './helpers.js';

describe('device pairing', () => {
  let server: TestServer;
  let user: TestAccount;
  const password = 'correct-horse-battery-staple';

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'pairing@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('starting a pairing returns a URL and a code to compare', async () => {
    const response = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Workstation', platform: 'desktop' },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.requestId);
    assert.ok(response.body.pollToken);
    // A short code the person reads off the client and compares in the
    // browser, so approving somebody else's pending request is visible.
    assert.match(response.body.userCode, /^\d{3}-\d{3}$/);
    assert.ok(response.body.verificationUrl.startsWith('https://sync.test/link-device?request='));
  });

  test('polling before approval reports pending, not a session', async () => {
    const started = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Laptop', platform: 'desktop' },
    });
    const polled = await api(server, 'POST', '/v1/desktop-auth/exchange', {
      body: { requestId: started.body.requestId, pollToken: started.body.pollToken },
    });
    assert.equal(polled.status, 202);
    assert.equal(polled.body.status, 'pending');
    assert.equal(polled.body.accessToken, undefined);
  });

  test('approving needs the password again, not just a live session', async () => {
    const started = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Laptop', platform: 'desktop' },
    });
    const wrongPassword = await api(server, 'POST', '/v1/desktop-auth/approve', {
      token: user.accessToken,
      body: { requestId: started.body.requestId, password: 'not-the-password' },
    });
    assert.equal(wrongPassword.status, 401);

    const stillPending = await api(server, 'POST', '/v1/desktop-auth/exchange', {
      body: { requestId: started.body.requestId, pollToken: started.body.pollToken },
    });
    assert.equal(stillPending.status, 202);
  });

  test('a full pairing hands the client a working session exactly once', async () => {
    const started = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Studio Mac', platform: 'desktop' },
    });

    const approved = await api(server, 'POST', '/v1/desktop-auth/approve', {
      token: user.accessToken,
      body: { requestId: started.body.requestId, password },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approved, true);

    const exchanged = await api(server, 'POST', '/v1/desktop-auth/exchange', {
      body: { requestId: started.body.requestId, pollToken: started.body.pollToken },
    });
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.status, 'complete');
    assert.ok(exchanged.body.accessToken);
    assert.ok(exchanged.body.refreshToken);
    assert.equal(exchanged.body.entitlements.canSync, true);
    assert.ok(Array.isArray(exchanged.body.vaults));

    const me = await api(server, 'GET', '/v1/account/me', { token: exchanged.body.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'pairing@example.com');

    // A pairing request is single-use. Polling it again must not mint a second
    // session for whoever else has the token.
    const replay = await api(server, 'POST', '/v1/desktop-auth/exchange', {
      body: { requestId: started.body.requestId, pollToken: started.body.pollToken },
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'pairing_used');
  });

  test('the wrong poll token gets nothing, even after approval', async () => {
    const started = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Phone', platform: 'ios' },
    });
    await api(server, 'POST', '/v1/desktop-auth/approve', {
      token: user.accessToken,
      body: { requestId: started.body.requestId, password },
    });

    const guessed = await api(server, 'POST', '/v1/desktop-auth/exchange', {
      body: { requestId: started.body.requestId, pollToken: 'dpt_a-token-that-was-never-issued' },
    });
    assert.equal(guessed.status, 401);
    assert.equal(guessed.body.error.code, 'pairing_invalid');
  });

  test('the pending request can be inspected without signing in', async () => {
    const started = await api(server, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Kiosk', platform: 'desktop' },
    });
    const response = await api(server, 'GET', `/v1/desktop-auth/request/${started.body.requestId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.deviceName, 'Kiosk');
    assert.equal(response.body.status, 'pending');
    // The poll token must not come back here: this route is reachable by
    // anyone holding the request id from the URL.
    assert.equal(response.body.pollToken, undefined);
  });

  test('approving needs the second factor when the account has one', async () => {
    const fresh = await startTestServer();
    const account = await register(fresh, 'mfa-pairing@example.com');
    const setup = await api(fresh, 'POST', '/v1/account/mfa/totp/setup', {
      token: account.accessToken,
      body: { password },
    });
    await api(fresh, 'POST', '/v1/account/mfa/totp/confirm', {
      token: account.accessToken,
      body: { code: totpCodeAtStep(setup.body.secret, Math.floor(Date.now() / 1000 / 30)) },
    });

    const started = await api(fresh, 'POST', '/v1/desktop-auth/start', {
      body: { deviceName: 'Workstation', platform: 'desktop' },
    });
    const withoutCode = await api(fresh, 'POST', '/v1/desktop-auth/approve', {
      token: account.accessToken,
      body: { requestId: started.body.requestId, password },
    });
    assert.equal(withoutCode.status, 400);
    assert.equal(withoutCode.body.error.code, 'mfa_code_required');

    await fresh.db.prepare('UPDATE user_mfa SET last_totp_step = NULL WHERE user_id = ?').run(account.userId);
    const withCode = await api(fresh, 'POST', '/v1/desktop-auth/approve', {
      token: account.accessToken,
      body: {
        requestId: started.body.requestId,
        password,
        mfaCode: totpCodeAtStep(setup.body.secret, Math.floor(Date.now() / 1000 / 30)),
      },
    });
    assert.equal(withCode.status, 200);
    await fresh.close();
  });
});

describe('legacy snapshot compatibility', () => {
  let server: TestServer;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'legacy@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('status reports nothing before the first upload', async () => {
    const response = await api(server, 'GET', '/v1/desktop/vault/status?vaultId=legacy-vault', {
      token: user.accessToken,
    });
    assert.equal(response.status, 403);
  });

  test('a snapshot uploads, reads back and refuses a stale base version', async () => {
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId: 'legacy-vault',
        items: [
          {
            id: 'seed',
            vaultId: 'legacy-vault',
            itemType: 'Host',
            ciphertext: 'b64:c2VlZC1jaXBoZXJ0ZXh0LWJ5dGVz',
            nonce: 'bm9uY2UtYnl0ZXM=',
            schemaVersion: 1,
            clientRevision: 1,
            updatedAt: '2026-01-01T12:00:00.000Z',
          },
        ],
      },
    });

    const uploaded = await api(server, 'PUT', '/v1/desktop/vault', {
      token: user.accessToken,
      body: { vaultId: 'legacy-vault', baseVersion: 0, blob: 'b64:ZW5jcnlwdGVkLXNuYXBzaG90LWJsb2I' },
    });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.version, 1);

    const read = await api(server, 'GET', '/v1/desktop/vault?vaultId=legacy-vault', {
      token: user.accessToken,
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.version, 1);
    assert.equal(read.body.blob, 'b64:ZW5jcnlwdGVkLXNuYXBzaG90LWJsb2I');

    // Without this check two devices that both uploaded would silently
    // overwrite each other's entire vault.
    const stale = await api(server, 'PUT', '/v1/desktop/vault', {
      token: user.accessToken,
      body: { vaultId: 'legacy-vault', baseVersion: 0, blob: 'b64:YW5vdGhlci1zbmFwc2hvdC1ibG9i' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'sync_version_conflict');
  });

  test('watch answers straight away when the caller is already behind', async () => {
    const response = await api(server, 'GET', '/v1/desktop/vault/watch?vaultId=legacy-vault&afterVersion=0', {
      token: user.accessToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.exists, true);
    assert.equal(response.body.version, 1);
  });

  test('watch waits, then reports the change a push made', async () => {
    const started = Date.now();
    const waiting = api(server, 'GET', '/v1/desktop/vault/watch?vaultId=legacy-vault&afterVersion=1', {
      token: user.accessToken,
    });

    // Give the long poll a moment to register before waking it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api(server, 'PUT', '/v1/desktop/vault', {
      token: user.accessToken,
      body: { vaultId: 'legacy-vault', baseVersion: 1, blob: 'b64:c2Vjb25kLXNuYXBzaG90LWJsb2I' },
    });

    const response = await waiting;
    assert.equal(response.status, 200);
    assert.equal(response.body.version, 2);
    // It must return on the event, not sit out the full timeout.
    assert.ok(Date.now() - started < 5000);
  });
});
