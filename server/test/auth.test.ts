import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { api, login, register, type TestServer, startTestServer } from './helpers.js';

describe('authentication', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  test('the first account becomes the administrator', async () => {
    const admin = await register(server, 'admin@example.com');
    const me = await api(server, 'GET', '/v1/account/me', { token: admin.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'admin');
    // Every account starts with a personal vault, or the client has nowhere to sync to.
    assert.equal(me.body.vaults.length, 1);
    assert.equal(me.body.vaults[0].kind, 'personal');
    assert.equal(me.body.entitlements.canSync, true);
  });

  test('registration is invite-only by default once an administrator exists', async () => {
    const response = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'walkin@example.com', password: 'correct-horse-battery-staple' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'invite_required');
  });

  test('a duplicate email is refused', async () => {
    // On an invite-only server the policy answers first, so the address is
    // not confirmed to anyone without an invitation.
    const refused = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'admin@example.com', password: 'correct-horse-battery-staple' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'invite_required');

    const admin = await login(server, 'admin@example.com', 'correct-horse-battery-staple');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.body.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
    const response = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'admin@example.com', password: 'correct-horse-battery-staple' },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'account_exists');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.body.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'invite' },
    });
  });

  test('a short password is refused', async () => {
    const response = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'short@example.com', password: 'short' },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'validation_failed');
  });

  test('sign-in returns a session and a wrong password does not', async () => {
    const good = await login(server, 'admin@example.com', 'correct-horse-battery-staple');
    assert.equal(good.status, 200);
    assert.ok(good.body.accessToken);
    assert.ok(good.body.refreshToken);

    const bad = await login(server, 'admin@example.com', 'wrong-password-entirely');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'invalid_credentials');
  });

  test('an unknown email gets the same answer as a wrong password', async () => {
    const unknown = await login(server, 'nobody@example.com', 'correct-horse-battery-staple');
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, 'invalid_credentials');
  });

  test('a refresh token rotates, and the old one is dead', async () => {
    const session = await login(server, 'admin@example.com', 'correct-horse-battery-staple');
    const first = await api(server, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: session.body.refreshToken },
    });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, session.body.refreshToken);

    // Replaying the rotated token is treated as compromise: the whole device
    // is signed out rather than the request simply failing.
    const replay = await api(server, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: session.body.refreshToken },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'refresh_token_reused');

    const afterRevoke = await api(server, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: first.body.refreshToken },
    });
    assert.equal(afterRevoke.status, 401);
  });

  test('an unauthenticated request is refused', async () => {
    const response = await api(server, 'GET', '/v1/account/me');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'unauthorized');
  });

  test('a forged access token is refused', async () => {
    const response = await api(server, 'GET', '/v1/account/me', {
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.not-a-real-signature',
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'invalid_token');
  });

  test('signing out kills the session even though the access token has not expired', async () => {
    const session = await login(server, 'admin@example.com', 'correct-horse-battery-staple');
    const before = await api(server, 'GET', '/v1/account/me', { token: session.body.accessToken });
    assert.equal(before.status, 200);

    await api(server, 'POST', '/v1/auth/logout', {
      body: { refreshToken: session.body.refreshToken },
    });

    // The signature is still valid; the device is not. Checking the device on
    // every request is what makes sign-out immediate.
    const afterLogout = await api(server, 'GET', '/v1/account/me', { token: session.body.accessToken });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.body.error.code, 'device_revoked');
  });

  test('changing the password signs other devices out but keeps the current one', async () => {
    const first = await login(server, 'admin@example.com', 'correct-horse-battery-staple');
    const second = await login(server, 'admin@example.com', 'correct-horse-battery-staple');

    const changed = await api(server, 'POST', '/v1/auth/password/change', {
      token: second.body.accessToken,
      body: { currentPassword: 'correct-horse-battery-staple', newPassword: 'a-brand-new-passphrase' },
    });
    assert.equal(changed.status, 204);

    const stillHere = await api(server, 'GET', '/v1/account/me', { token: second.body.accessToken });
    assert.equal(stillHere.status, 200);

    const otherDevice = await api(server, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: first.body.refreshToken },
    });
    assert.equal(otherDevice.status, 401);

    // Restore for the tests that run after this one.
    await api(server, 'POST', '/v1/auth/password/change', {
      token: second.body.accessToken,
      body: { currentPassword: 'a-brand-new-passphrase', newPassword: 'correct-horse-battery-staple' },
    });
  });

  test('a password reset never reveals whether the address exists', async () => {
    const known = await api(server, 'POST', '/v1/auth/password/reset/request', {
      body: { email: 'admin@example.com' },
    });
    const unknown = await api(server, 'POST', '/v1/auth/password/reset/request', {
      body: { email: 'nobody-at-all@example.com' },
    });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);
  });
});

describe('registration modes', () => {
  test('open mode lets anyone register', async () => {
    const server = await startTestServer();
    const admin = await register(server, 'admin@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });

    const walkIn = await register(server, 'anyone@example.com');
    assert.ok(walkIn.accessToken);
    const me = await api(server, 'GET', '/v1/account/me', { token: walkIn.accessToken });
    assert.equal(me.body.user.role, 'user');
    await server.close();
  });

  test('domain mode accepts listed domains and refuses the rest', async () => {
    const server = await startTestServer();
    const admin = await register(server, 'admin@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: {
        serverName: 'Test Server',
        registrationMode: 'domain',
        allowedEmailDomains: ['allowed.test'],
      },
    });

    const allowed = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'someone@allowed.test', password: 'correct-horse-battery-staple' },
    });
    assert.equal(allowed.status, 201);

    const refused = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'someone@other.test', password: 'correct-horse-battery-staple' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'email_domain_not_allowed');
    await server.close();
  });

  test('an invitation works once, and only for the address it names', async () => {
    const server = await startTestServer();
    const admin = await register(server, 'admin@example.com');

    const invite = await api(server, 'POST', '/v1/admin/invites', {
      token: admin.accessToken,
      body: { email: 'invited@example.com', role: 'user' },
    });
    assert.equal(invite.status, 201);
    const token = invite.body.token;

    const wrongAddress = await api(server, 'POST', '/v1/auth/register', {
      body: {
        email: 'someone-else@example.com',
        password: 'correct-horse-battery-staple',
        inviteToken: token,
      },
    });
    assert.equal(wrongAddress.status, 403);
    assert.equal(wrongAddress.body.error.code, 'invite_invalid');

    const accepted = await register(server, 'invited@example.com', { inviteToken: token });
    assert.ok(accepted.accessToken);

    // The invitation is spent. A second account cannot come out of it.
    const reuse = await api(server, 'POST', '/v1/auth/register', {
      body: { email: 'invited@example.com', password: 'correct-horse-battery-staple', inviteToken: token },
    });
    assert.equal(reuse.status, 403);
    assert.equal(reuse.body.error.code, 'invite_invalid');
    await server.close();
  });

  test('an invitation can grant the administrator role', async () => {
    const server = await startTestServer();
    const admin = await register(server, 'admin@example.com');
    const invite = await api(server, 'POST', '/v1/admin/invites', {
      token: admin.accessToken,
      body: { email: 'second-admin@example.com', role: 'admin' },
    });
    const second = await register(server, 'second-admin@example.com', { inviteToken: invite.body.token });
    const me = await api(server, 'GET', '/v1/account/me', { token: second.accessToken });
    assert.equal(me.body.user.role, 'admin');
    await server.close();
  });
});
