import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { totpCodeAtStep } from '../src/auth/totp.js';
import { api, login, register, startTestServer, type TestServer } from './helpers.js';

/**
 * What happens when MFA_ENCRYPTION_KEY no longer matches the stored secrets.
 *
 * A restored backup with the wrong key, or a rotated one, is a realistic
 * operator mistake. It has to produce an answer that names the cause, not a
 * generic failure that sends someone hunting through logs.
 */
describe('a rotated MFA encryption key', () => {
  test('is reported as a configuration problem, and never lets a sign-in through', async () => {
    const server = await startTestServer();
    const user = await register(server, 'rotated@example.com');
    const password = 'correct-horse-battery-staple';

    const setup = await api(server, 'POST', '/v1/account/mfa/totp/setup', {
      token: user.accessToken,
      body: { password },
    });
    await api(server, 'POST', '/v1/account/mfa/totp/confirm', {
      token: user.accessToken,
      body: { code: totpCodeAtStep(setup.body.secret, Math.floor(Date.now() / 1000 / 30)) },
    });

    // The same database, served by a process configured with a different key.
    const rotatedConfig = loadConfig({
      NODE_ENV: 'test',
      DATABASE_FILE: ':memory:',
      SYNC_JWT_SECRET: 'test-secret-that-is-long-enough-for-tests-0123456789',
      MFA_ENCRYPTION_KEY: 'a-completely-different-key-from-the-original-0123456789',
      SETTINGS_ENCRYPTION_KEY: 'test-settings-key-long-enough-for-tests-0123456789',
      RATE_LIMIT_DISABLED: '1',
      WEB_ROOT: '',
    } as NodeJS.ProcessEnv);
    const rotated = await buildServer(rotatedConfig, server.db);
    await rotated.app.ready();
    const rotatedServer: TestServer = { ...server, app: rotated.app, config: rotatedConfig };

    const challenge = await login(rotatedServer, 'rotated@example.com', password);
    assert.equal(challenge.status, 202, 'the password step still works');

    const attempt = await api(rotatedServer, 'POST', '/v1/auth/mfa/verify', {
      body: {
        challengeToken: challenge.body.challengeToken,
        code: totpCodeAtStep(setup.body.secret, Math.floor(Date.now() / 1000 / 30)),
      },
    });
    assert.equal(attempt.body.error.code, 'mfa_secret_unreadable');
    assert.match(attempt.body.error.message, /MFA_ENCRYPTION_KEY/);
    // Fails closed. No session comes out of this, however the operator got here.
    assert.equal(attempt.body.accessToken, undefined);

    rotated.syncEvents.close();
    await rotated.app.close();
    await server.close();
  });

  test('an administrator can clear it, and the account recovers', async () => {
    const server = await startTestServer();
    const admin = await register(server, 'admin@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
    const user = await register(server, 'stuck@example.com');

    const setup = await api(server, 'POST', '/v1/account/mfa/totp/setup', {
      token: user.accessToken,
      body: { password: 'correct-horse-battery-staple' },
    });
    await api(server, 'POST', '/v1/account/mfa/totp/confirm', {
      token: user.accessToken,
      body: { code: totpCodeAtStep(setup.body.secret, Math.floor(Date.now() / 1000 / 30)) },
    });

    // The documented way out: an administrator clears the factor.
    const reset = await api(server, 'DELETE', `/v1/admin/users/${user.userId}/mfa`, {
      token: admin.accessToken,
    });
    assert.equal(reset.status, 200);

    const signIn = await login(server, 'stuck@example.com', 'correct-horse-battery-staple');
    assert.equal(signIn.status, 200);
    await server.close();
  });
});
