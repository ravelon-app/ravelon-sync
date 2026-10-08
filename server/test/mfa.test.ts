import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { totpCodeAtStep } from '../src/auth/totp.js';
import { api, login, register, startTestServer, type TestAccount, type TestServer } from './helpers.js';

function currentCode(secret: string): string {
  return totpCodeAtStep(secret, Math.floor(Date.now() / 1000 / 30));
}

/**
 * Pretends the clock moved to a fresh time step.
 *
 * The server refuses a TOTP step it already accepted, which is the point of
 * replay protection but leaves a test with only one usable code per 30
 * seconds. Clearing the high-water mark stands in for waiting, so each test
 * gets a code the server will accept without the suite sleeping.
 */
async function allowNextCode(server: TestServer, userId: string): Promise<void> {
  await server.db.prepare('UPDATE user_mfa SET last_totp_step = NULL WHERE user_id = ?').run(userId);
}

describe('two-factor authentication', () => {
  let server: TestServer;
  let user: TestAccount;
  let secret: string;
  let recoveryCodes: string[];
  const password = 'correct-horse-battery-staple';

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'mfa@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('setup needs the password, not just a live session', async () => {
    const noProof = await api(server, 'POST', '/v1/account/mfa/totp/setup', {
      token: user.accessToken,
      body: {},
    });
    assert.equal(noProof.status, 400);
    assert.equal(noProof.body.error.code, 'reauthentication_required');

    const wrongPassword = await api(server, 'POST', '/v1/account/mfa/totp/setup', {
      token: user.accessToken,
      body: { password: 'not-the-right-password' },
    });
    assert.equal(wrongPassword.status, 401);
  });

  test('setup returns a secret and an otpauth URI', async () => {
    const response = await api(server, 'POST', '/v1/account/mfa/totp/setup', {
      token: user.accessToken,
      body: { password },
    });
    assert.equal(response.status, 200);
    assert.match(response.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(response.body.uri, /^otpauth:\/\/totp\//);
    assert.ok(response.body.uri.includes('mfa%40example.com'));
    secret = response.body.secret;
  });

  test('an unconfirmed enrolment does not yet gate sign-in', async () => {
    const session = await login(server, 'mfa@example.com', password);
    assert.equal(session.status, 200);
    assert.ok(session.body.accessToken);
  });

  test('a wrong code does not confirm enrolment', async () => {
    const response = await api(server, 'POST', '/v1/account/mfa/totp/confirm', {
      token: user.accessToken,
      body: { code: '000000' },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_mfa_code');
  });

  test('a correct code confirms enrolment and returns recovery codes once', async () => {
    const response = await api(server, 'POST', '/v1/account/mfa/totp/confirm', {
      token: user.accessToken,
      body: { code: currentCode(secret) },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.enabled, true);
    assert.equal(response.body.recoveryCodes.length, 10);
    recoveryCodes = response.body.recoveryCodes;

    const status = await api(server, 'GET', '/v1/account/mfa', { token: user.accessToken });
    assert.equal(status.body.enabled, true);
    assert.equal(status.body.recoveryCodesRemaining, 10);
  });

  test('sign-in now returns a challenge instead of a session', async () => {
    const response = await login(server, 'mfa@example.com', password);
    assert.equal(response.status, 202);
    assert.equal(response.body.mfaRequired, true);
    assert.ok(response.body.challengeToken);
    // The password alone must not produce anything usable.
    assert.equal(response.body.accessToken, undefined);
    assert.equal(response.body.refreshToken, undefined);
  });

  test('a client that cannot do MFA is told so rather than let in', async () => {
    const response = await login(server, 'mfa@example.com', password, { mfaSupported: false });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'mfa_client_unsupported');
  });

  test('the challenge is completed with a code from the authenticator', async () => {
    await allowNextCode(server, user.userId);
    const challenge = await login(server, 'mfa@example.com', password);
    const response = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.body.challengeToken, code: currentCode(secret) },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.accessToken);
    user = { ...user, accessToken: response.body.accessToken, refreshToken: response.body.refreshToken };
  });

  test('the same code cannot be used a second time', async () => {
    await allowNextCode(server, user.userId);
    const code = currentCode(secret);
    const first = await login(server, 'mfa@example.com', password);
    const accepted = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: first.body.challengeToken, code },
    });
    assert.equal(accepted.status, 200);

    // Replaying a code observed over the shoulder must not work, even inside
    // the window where it is otherwise still valid.
    const second = await login(server, 'mfa@example.com', password);
    const replayed = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: second.body.challengeToken, code },
    });
    assert.equal(replayed.status, 400);
    assert.equal(replayed.body.error.code, 'invalid_mfa_code');
  });

  test('a challenge cannot be spent twice', async () => {
    await allowNextCode(server, user.userId);
    const challenge = await login(server, 'mfa@example.com', password);
    const first = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.body.challengeToken, code: currentCode(secret) },
    });
    assert.equal(first.status, 200);

    // A spent challenge is dead even when the code presented with it is fine.
    const second = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.body.challengeToken, code: recoveryCodes[9] },
    });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'invalid_mfa_challenge');
  });

  test('a recovery code works once and is then spent', async () => {
    const challenge = await login(server, 'mfa@example.com', password);
    const code = recoveryCodes[0];
    const accepted = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.body.challengeToken, code },
    });
    assert.equal(accepted.status, 200);

    const status = await api(server, 'GET', '/v1/account/mfa', { token: accepted.body.accessToken });
    assert.equal(status.body.recoveryCodesRemaining, 9);

    const again = await login(server, 'mfa@example.com', password);
    const reused = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: again.body.challengeToken, code },
    });
    assert.equal(reused.status, 400);
  });

  test('turning MFA off needs the password and a current code', async () => {
    const challenge = await login(server, 'mfa@example.com', password);
    const session = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.body.challengeToken, code: recoveryCodes[1] },
    });
    const token = session.body.accessToken;

    const withoutCode = await api(server, 'DELETE', '/v1/account/mfa', {
      token,
      body: { password },
    });
    assert.equal(withoutCode.status, 400);
    assert.equal(withoutCode.body.error.code, 'mfa_code_required');

    const disabled = await api(server, 'DELETE', '/v1/account/mfa', {
      token,
      body: { password, mfaCode: recoveryCodes[2] },
    });
    assert.equal(disabled.status, 204);

    const afterDisable = await login(server, 'mfa@example.com', password);
    assert.equal(afterDisable.status, 200);
    assert.ok(afterDisable.body.accessToken);
  });

  test('the TOTP secret is not stored in the clear', async () => {
    const fresh = await startTestServer();
    const account = await register(fresh, 'secret@example.com');
    const setup = await api(fresh, 'POST', '/v1/account/mfa/totp/setup', {
      token: account.accessToken,
      body: { password: 'correct-horse-battery-staple' },
    });
    await api(fresh, 'POST', '/v1/account/mfa/totp/confirm', {
      token: account.accessToken,
      body: { code: currentCode(setup.body.secret) },
    });

    const row = await fresh.db
      .prepare('SELECT totp_secret_encrypted FROM user_mfa WHERE user_id = ?')
      .get<{ totp_secret_encrypted: string }>(account.userId);
    assert.ok(row);
    assert.notEqual(row.totp_secret_encrypted, setup.body.secret);
    assert.ok(!row.totp_secret_encrypted.includes(setup.body.secret));
    assert.match(row.totp_secret_encrypted, /^v1\./);

    // Recovery codes are keyed hashes, so a copy of this table is not a way in.
    const codes = await fresh.db
      .prepare('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ?')
      .all<{ code_hash: string }>(account.userId);
    assert.equal(codes.length, 10);
    for (const stored of codes) {
      assert.ok(!/^[A-Z2-7]{4}-/.test(stored.code_hash));
    }
    await fresh.close();
  });

  test('an administrator can clear a lost second factor', async () => {
    const fresh = await startTestServer();
    const admin = await register(fresh, 'admin@example.com');
    await api(fresh, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
    const locked = await register(fresh, 'locked-out@example.com');

    const setup = await api(fresh, 'POST', '/v1/account/mfa/totp/setup', {
      token: locked.accessToken,
      body: { password: 'correct-horse-battery-staple' },
    });
    await api(fresh, 'POST', '/v1/account/mfa/totp/confirm', {
      token: locked.accessToken,
      body: { code: currentCode(setup.body.secret) },
    });
    assert.equal((await login(fresh, 'locked-out@example.com', 'correct-horse-battery-staple')).status, 202);

    const reset = await api(fresh, 'DELETE', `/v1/admin/users/${locked.userId}/mfa`, {
      token: admin.accessToken,
    });
    assert.equal(reset.status, 200);

    const afterReset = await login(fresh, 'locked-out@example.com', 'correct-horse-battery-staple');
    assert.equal(afterReset.status, 200);
    await fresh.close();
  });
});
