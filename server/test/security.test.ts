import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { totpCodeAtStep } from '../src/auth/totp.js';
import { ConfigError, loadConfig, newId, nowIso } from '../src/config.js';
import { sha256 } from '../src/lib/crypto.js';
import {
  api,
  login,
  register,
  startTestServer,
  type TestAccount,
  type TestServer,
} from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

/** Rate limits on, with a small failure budget so a lockout is reachable. */
const LIMITED = {
  RATE_LIMIT_DISABLED: '0',
  RATE_LIMIT_AUTH_FAILURES: '3',
  RATE_LIMIT_AUTH_PER_IP: '1000',
  RATE_LIMIT_API_PER_USER: '1000',
};

function currentCode(secret: string): string {
  return totpCodeAtStep(secret, Math.floor(Date.now() / 1000 / 30));
}

async function allowNextCode(server: TestServer, userId: string): Promise<void> {
  await server.db.prepare('UPDATE user_mfa SET last_totp_step = NULL WHERE user_id = ?').run(userId);
}

async function enrollMfa(server: TestServer, account: TestAccount): Promise<string> {
  const setup = await api(server, 'POST', '/v1/account/mfa/totp/setup', {
    token: account.accessToken,
    body: { password: account.password },
  });
  assert.equal(setup.status, 200);
  const confirmed = await api(server, 'POST', '/v1/account/mfa/totp/confirm', {
    token: account.accessToken,
    body: { code: currentCode(setup.body.secret) },
  });
  assert.equal(confirmed.status, 200);
  await allowNextCode(server, account.userId);
  return setup.body.secret as string;
}

async function openRegistration(server: TestServer, admin: TestAccount, extra: Record<string, unknown> = {}) {
  const response = await api(server, 'PUT', '/v1/admin/settings/platform', {
    token: admin.accessToken,
    body: { serverName: 'Test Server', registrationMode: 'open', ...extra },
  });
  assert.equal(response.status, 200);
}

async function auditRows(server: TestServer, action: string) {
  return await server.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY created_at')
    .all<{ actor_user_id: string | null; target: string | null; detail_json: string | null }>(action);
}

/** Inserts a reset token the test knows, since the real one only travels by mail. */
async function insertResetToken(server: TestServer, userId: string, token: string): Promise<void> {
  await server.db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(newId(), userId, sha256(token), new Date(Date.now() + 3_600_000).toISOString(), nowIso());
}

describe('public origin for emailed links', () => {
  test('production refuses to start without PUBLIC_URL', () => {
    const env = {
      NODE_ENV: 'production',
      SYNC_JWT_SECRET: 'a-production-secret-with-plenty-of-entropy-0123456789',
    };
    assert.throws(() => loadConfig(env as NodeJS.ProcessEnv), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /PUBLIC_URL is required in production/);
      return true;
    });
    const config = loadConfig({ ...env, PUBLIC_URL: 'https://sync.example.com' } as NodeJS.ProcessEnv);
    assert.equal(config.publicUrl, 'https://sync.example.com');
  });

  test('a forged X-Forwarded-Host from an untrusted peer does not reach the link', async () => {
    const server = await startTestServer({ PUBLIC_URL: '' });
    try {
      const admin = await register(server, 'admin@example.com');
      const invite = await api(server, 'POST', '/v1/admin/invites', {
        token: admin.accessToken,
        body: {},
        headers: {
          host: 'sync.local',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'https',
        },
      });
      assert.equal(invite.status, 201);
      assert.ok(
        invite.body.inviteUrl.startsWith('http://sync.local/signup?invite='),
        invite.body.inviteUrl,
      );
    } finally {
      await server.close();
    }
  });

  test('a trusted proxy may still report the public host', async () => {
    const server = await startTestServer({ PUBLIC_URL: '', TRUSTED_PROXY_IPS: '127.0.0.1' });
    try {
      const admin = await register(server, 'admin@example.com');
      const invite = await api(server, 'POST', '/v1/admin/invites', {
        token: admin.accessToken,
        body: {},
        headers: {
          host: 'internal:4100',
          'x-forwarded-host': 'sync.example.com',
          'x-forwarded-proto': 'https',
        },
      });
      assert.ok(
        invite.body.inviteUrl.startsWith('https://sync.example.com/signup?invite='),
        invite.body.inviteUrl,
      );
    } finally {
      await server.close();
    }
  });
});

describe('two-factor lockout per account', () => {
  let server: TestServer;
  let user: TestAccount;
  let secret: string;

  before(async () => {
    server = await startTestServer(LIMITED);
    user = await register(server, 'mfa-lock@example.com');
    secret = await enrollMfa(server, user);
  });

  after(async () => {
    await server.close();
  });

  test('fresh challenges do not reset the count of wrong codes', async () => {
    const first = await login(server, user.email, PASSWORD);
    assert.equal(first.status, 202);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wrong = await api(server, 'POST', '/v1/auth/mfa/verify', {
        body: { challengeToken: first.body.challengeToken, code: '000000' },
      });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.error.code, 'invalid_mfa_code');
    }

    // A new challenge per guess used to get a new budget per guess.
    const second = await login(server, user.email, PASSWORD);
    assert.equal(second.status, 202);
    const third = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: second.body.challengeToken, code: '000001' },
    });
    assert.equal(third.status, 400);

    const locked = await api(server, 'POST', '/v1/auth/mfa/verify', {
      body: { challengeToken: second.body.challengeToken, code: currentCode(secret) },
    });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'too_many_attempts');

    const nextSignIn = await login(server, user.email, PASSWORD);
    assert.equal(nextSignIn.status, 429);
  });

  test('wrong codes are in the audit trail', async () => {
    const rows = await auditRows(server, 'auth.mfa_failed');
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((row) => row.actor_user_id === user.userId));
    assert.ok(rows.every((row) => !String(row.detail_json).includes('000000')));
  });
});

describe('sensitive account changes', () => {
  let server: TestServer;
  let user: TestAccount;
  let secret: string;

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'sensitive@example.com');
    secret = await enrollMfa(server, user);
  });

  after(async () => {
    await server.close();
  });

  test('new recovery codes need the second factor, not only the password', async () => {
    const passwordOnly = await api(server, 'POST', '/v1/account/mfa/recovery-codes', {
      token: user.accessToken,
      body: { password: PASSWORD },
    });
    assert.equal(passwordOnly.status, 400);
    assert.equal(passwordOnly.body.error.code, 'mfa_code_required');

    const wrongCode = await api(server, 'POST', '/v1/account/mfa/recovery-codes', {
      token: user.accessToken,
      body: { password: PASSWORD, mfaCode: '000000' },
    });
    assert.equal(wrongCode.status, 400);
    assert.equal(wrongCode.body.error.code, 'invalid_mfa_code');

    await allowNextCode(server, user.userId);
    const replaced = await api(server, 'POST', '/v1/account/mfa/recovery-codes', {
      token: user.accessToken,
      body: { password: PASSWORD, mfaCode: currentCode(secret) },
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.recoveryCodes.length, 10);
  });

  test('a wrong current password is 400, so clients do not mistake it for an expired session', async () => {
    const wrong = await api(server, 'POST', '/v1/auth/password/change', {
      token: user.accessToken,
      body: { currentPassword: 'not-the-password', newPassword: 'another-long-password' },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'invalid_credentials');

    // The session is untouched by the typo.
    const me = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
    assert.equal(me.status, 200);
  });

  test('a password change checks a second factor when one is sent', async () => {
    const wrongCode = await api(server, 'POST', '/v1/auth/password/change', {
      token: user.accessToken,
      body: { currentPassword: PASSWORD, newPassword: 'another-long-password', mfaCode: '000000' },
    });
    assert.equal(wrongCode.status, 400);
    assert.equal(wrongCode.body.error.code, 'invalid_mfa_code');
    const signIn = await login(server, user.email, PASSWORD);
    assert.equal(signIn.status, 202, 'the password must not have changed');
  });

  test('changing the password spends outstanding reset links', async () => {
    await insertResetToken(server, user.userId, 'prt_outstanding-before-change-0001');
    const changed = await api(server, 'POST', '/v1/auth/password/change', {
      token: user.accessToken,
      // Desktop and iOS send no code; they must keep working.
      body: { currentPassword: PASSWORD, newPassword: 'the-new-account-password' },
    });
    assert.equal(changed.status, 204);

    const reset = await api(server, 'POST', '/v1/auth/password/reset/confirm', {
      body: { token: 'prt_outstanding-before-change-0001', newPassword: 'attacker-chosen-password' },
    });
    assert.equal(reset.status, 400);
    assert.equal(reset.body.error.code, 'invalid_reset_token');
  });

  test('a reset spends every other outstanding reset link', async () => {
    await insertResetToken(server, user.userId, 'prt_first-link-in-the-inbox-0001');
    await insertResetToken(server, user.userId, 'prt_second-link-in-the-inbox-002');
    const first = await api(server, 'POST', '/v1/auth/password/reset/confirm', {
      body: { token: 'prt_first-link-in-the-inbox-0001', newPassword: PASSWORD },
    });
    assert.equal(first.status, 204);
    const second = await api(server, 'POST', '/v1/auth/password/reset/confirm', {
      body: { token: 'prt_second-link-in-the-inbox-002', newPassword: 'attacker-chosen-password' },
    });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'invalid_reset_token');
  });
});

describe('password change lockout', () => {
  test('repeated wrong current passwords lock the change, even with the right one', async () => {
    const server = await startTestServer(LIMITED);
    try {
      const user = await register(server, 'guessing@example.com');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const wrong = await api(server, 'POST', '/v1/auth/password/change', {
          token: user.accessToken,
          body: { currentPassword: `wrong-guess-${attempt}`, newPassword: 'another-long-password' },
        });
        assert.equal(wrong.status, 400);
      }
      const locked = await api(server, 'POST', '/v1/auth/password/change', {
        token: user.accessToken,
        body: { currentPassword: PASSWORD, newPassword: 'another-long-password' },
      });
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error.code, 'too_many_attempts');

      // The counter is shared with the other reauthentication routes, so the
      // guessing cannot simply move to account deletion.
      const elsewhere = await api(server, 'DELETE', '/v1/account', {
        token: user.accessToken,
        body: { password: PASSWORD },
      });
      assert.equal(elsewhere.status, 429);
    } finally {
      await server.close();
    }
  });
});

describe('domain sign-up', () => {
  test('an unconfirmed address at an allowed domain cannot sync', async () => {
    const server = await startTestServer();
    try {
      const admin = await register(server, 'admin@example.com');
      await api(server, 'PATCH', `/v1/admin/users/${admin.userId}`, {
        token: admin.accessToken,
        body: { emailVerified: true },
      });
      await api(server, 'PUT', '/v1/admin/settings/platform', {
        token: admin.accessToken,
        body: {
          serverName: 'Test Server',
          registrationMode: 'domain',
          allowedEmailDomains: ['corp.test'],
          requireEmailVerification: false,
        },
      });

      const impostor = await register(server, 'ceo@corp.test');
      const me = await api(server, 'GET', '/v1/account/me', { token: impostor.accessToken });
      assert.equal(me.body.entitlements.canSync, false);
      const vault = await api(server, 'POST', '/v1/vaults', {
        token: impostor.accessToken,
        body: { name: 'Sneaky' },
      });
      assert.equal(vault.status, 403);
      assert.equal(vault.body.error.code, 'email_verification_required');

      await server.db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(impostor.userId);
      const verified = await api(server, 'POST', '/v1/vaults', {
        token: impostor.accessToken,
        body: { name: 'Legit' },
      });
      assert.equal(verified.status, 201);
    } finally {
      await server.close();
    }
  });

  test('open sign-up keeps syncing without confirmation unless required', async () => {
    const server = await startTestServer();
    try {
      const admin = await register(server, 'admin@example.com');
      await openRegistration(server, admin);
      const walkIn = await register(server, 'walkin@example.com');
      const me = await api(server, 'GET', '/v1/account/me', { token: walkIn.accessToken });
      assert.equal(me.body.entitlements.canSync, true);
    } finally {
      await server.close();
    }
  });
});

describe('account deletion and team data', () => {
  let server: TestServer;
  let admin: TestAccount;
  let owner: TestAccount;
  let teamAdmin: TestAccount;
  let heir: TestAccount;
  let teamId: string;
  let adminVaultId: string;

  async function joinTeam(account: TestAccount, role: 'admin' | 'member') {
    const invite = await api(server, 'POST', `/v1/teams/${teamId}/invites`, {
      token: owner.accessToken,
      body: { email: account.email, role, vaultRole: 'editor' },
    });
    assert.equal(invite.status, 201);
    const accepted = await api(server, 'POST', `/v1/team-invites/${invite.body.token}/accept`, {
      token: account.accessToken,
    });
    assert.equal(accepted.status, 200);
  }

  before(async () => {
    server = await startTestServer();
    admin = await register(server, 'admin@example.com');
    await openRegistration(server, admin);
    owner = await register(server, 'owner@example.com');
    teamAdmin = await register(server, 'team-admin@example.com');
    heir = await register(server, 'heir@example.com');

    const team = await api(server, 'POST', '/v1/teams', {
      token: owner.accessToken,
      body: { name: 'Platform', vaultName: 'Platform Vault' },
    });
    teamId = team.body.id;
    await joinTeam(teamAdmin, 'admin');
    await joinTeam(heir, 'member');

    const vault = await api(server, 'POST', '/v1/vaults', {
      token: teamAdmin.accessToken,
      body: { name: 'Created by a team admin', kind: 'team', teamId },
    });
    assert.equal(vault.status, 201);
    adminVaultId = vault.body.id;
  });

  after(async () => {
    await server.close();
  });

  test('a team owner cannot delete their own account', async () => {
    const response = await api(server, 'DELETE', '/v1/account', {
      token: owner.accessToken,
      body: { password: PASSWORD },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'owns_teams');
  });

  test('an administrator cannot delete a team owner either', async () => {
    const response = await api(server, 'DELETE', `/v1/admin/users/${owner.userId}`, {
      token: admin.accessToken,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'owns_teams');
    const team = await server.db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    assert.ok(team);
  });

  test('deleting a team admin keeps the team vault they created', async () => {
    const response = await api(server, 'DELETE', '/v1/account', {
      token: teamAdmin.accessToken,
      body: { password: PASSWORD },
    });
    assert.equal(response.status, 204);
    const vault = await server.db.prepare('SELECT user_id FROM vaults WHERE id = ?')
      .get<{ user_id: string }>(adminVaultId);
    assert.equal(vault?.user_id, owner.userId);
  });

  test('transferring ownership moves the team vaults, and then the old owner can leave', async () => {
    const transferred = await api(server, 'POST', `/v1/teams/${teamId}/transfer-ownership`, {
      token: owner.accessToken,
      body: { userId: heir.userId },
    });
    assert.equal(transferred.status, 200);
    const owners = await server.db.prepare('SELECT DISTINCT user_id FROM vaults WHERE team_id = ?')
      .all<{ user_id: string }>(teamId);
    assert.deepEqual(owners.map((row) => row.user_id), [heir.userId]);

    const deleted = await api(server, 'DELETE', `/v1/admin/users/${owner.userId}`, {
      token: admin.accessToken,
    });
    assert.equal(deleted.status, 204);
    const vaults = await server.db.prepare('SELECT COUNT(*) AS count FROM vaults WHERE team_id = ?')
      .get<{ count: number }>(teamId);
    assert.equal(Number(vaults?.count), 2);
  });
});

describe('security headers and caching', () => {
  let server: TestServer;
  let webRoot: string;

  before(async () => {
    webRoot = mkdtempSync(path.join(tmpdir(), 'ravelon-web-'));
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1);');
    writeFileSync(path.join(webRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    server = await startTestServer({ WEB_ROOT: webRoot, TRUSTED_PROXY_IPS: '127.0.0.1' });
  });

  after(async () => {
    await server.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  async function headers(url: string, extra: Record<string, string> = {}) {
    const response = await server.app.inject({ method: 'GET', url, headers: extra });
    return { status: response.statusCode, headers: response.headers };
  }

  test('the interface is served with a strict content security policy', async () => {
    for (const url of ['/', '/account', '/v1/health']) {
      const response = await headers(url);
      const csp = String(response.headers['content-security-policy']);
      assert.match(csp, /default-src 'self'/, url);
      assert.match(csp, /script-src 'self'(;|$)/, url);
      assert.match(csp, /object-src 'none'/, url);
      assert.match(csp, /frame-ancestors 'none'/, url);
      assert.match(csp, /base-uri 'self'/, url);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, url);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.ok(response.headers['permissions-policy']);
    }
  });

  test('HSTS is only sent over HTTPS', async () => {
    const plain = await headers('/v1/health');
    assert.equal(plain.headers['strict-transport-security'], undefined);
    const secure = await headers('/v1/health', { 'x-forwarded-proto': 'https' });
    assert.match(String(secure.headers['strict-transport-security']), /max-age=\d+/);
  });

  test('hashed assets stay cacheable while API responses are never stored', async () => {
    const asset = await headers('/assets/index-abc123.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

    const page = await headers('/');
    assert.equal(page.headers['cache-control'], 'no-cache');
    const deepLink = await headers('/vaults');
    assert.equal(deepLink.headers['cache-control'], 'no-cache');
    const favicon = await headers('/favicon.svg');
    assert.equal(favicon.headers['cache-control'], 'no-cache');

    const apiResponse = await headers('/v1/health');
    assert.equal(apiResponse.headers['cache-control'], 'no-store');
    const missing = await headers('/v1/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cache-control'], 'no-store');
  });
});

describe('account enumeration', () => {
  let smtp: Server;
  const sockets = new Set<Socket>();

  before(async () => {
    // Accepts connections and never answers, like a slow or stuck relay.
    smtp = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });

  test('registration on an invite-only server does not confirm an existing address', async () => {
    const server = await startTestServer();
    try {
      await register(server, 'admin@example.com');
      const existing = await api(server, 'POST', '/v1/auth/register', {
        body: { email: 'admin@example.com', password: PASSWORD },
      });
      const unknown = await api(server, 'POST', '/v1/auth/register', {
        body: { email: 'nobody@example.com', password: PASSWORD },
      });
      assert.equal(existing.status, 403);
      assert.deepEqual(existing.body, unknown.body);
    } finally {
      await server.close();
    }
  });

  test('a reset request for a real account does not wait for the mail server', async () => {
    const port = (smtp.address() as { port: number }).port;
    const server = await startTestServer({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_SECURITY: 'none',
    });
    try {
      await register(server, 'admin@example.com');
      const started = Date.now();
      const response = await api(server, 'POST', '/v1/auth/password/reset/request', {
        body: { email: 'admin@example.com' },
      });
      assert.equal(response.status, 200);
      // The stuck relay would hold an awaited send for its 10 s greeting timeout.
      assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.close();
    }
  });
});

describe('audit trail', () => {
  let server: TestServer;
  let admin: TestAccount;

  before(async () => {
    server = await startTestServer();
    admin = await register(server, 'admin@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('a failed sign-in is recorded without the password', async () => {
    const failed = await login(server, 'admin@example.com', 'a-wrong-password-attempt');
    assert.equal(failed.status, 401);
    await login(server, 'ghost@example.com', 'another-wrong-password');

    const rows = await auditRows(server, 'auth.login_failed');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.actor_user_id, admin.userId);
    assert.equal(rows[1]?.actor_user_id, null);
    for (const row of rows) {
      assert.doesNotMatch(String(row.detail_json), /wrong-password/);
    }
  });

  test('a replayed refresh token is recorded', async () => {
    const session = await login(server, 'admin@example.com', PASSWORD);
    const rotated = await api(server, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: session.body.refreshToken },
    });
    assert.equal(rotated.status, 200);
    const replay = await api(server, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: session.body.refreshToken },
    });
    assert.equal(replay.status, 401);

    const rows = await auditRows(server, 'auth.refresh_reuse_detected');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor_user_id, admin.userId);
    assert.equal(rows[0]?.target, `device:${session.body.deviceId}`);
    assert.doesNotMatch(String(rows[0]?.detail_json), /rft_/);
  });

  test('an administrator changing verification or a name is recorded', async () => {
    await openRegistration(server, admin);
    const user = await register(server, 'person@example.com');
    const updated = await api(server, 'PATCH', `/v1/admin/users/${user.userId}`, {
      token: admin.accessToken,
      body: { emailVerified: true, displayName: 'Renamed' },
    });
    assert.equal(updated.status, 200);

    const rows = await auditRows(server, 'admin.user_update');
    const detail = JSON.parse(String(rows.at(-1)?.detail_json));
    assert.equal(detail.emailVerified, true);
    assert.equal(detail.displayName, 'Renamed');
    assert.deepEqual([...detail.changed].sort(), ['displayName', 'emailVerified']);
  });

  test('platform settings record every changed key', async () => {
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: admin.accessToken,
      body: {
        serverName: 'Renamed Server',
        registrationMode: 'open',
        requireEmailVerification: true,
        allowTeamCreation: false,
      },
    });
    const rows = await auditRows(server, 'admin.settings_platform');
    const detail = JSON.parse(String(rows.at(-1)?.detail_json));
    assert.deepEqual(
      [...detail.changed].sort(),
      ['allowTeamCreation', 'requireEmailVerification', 'serverName'],
    );
    assert.equal(detail.values.requireEmailVerification, true);
  });
});

describe('general per-account request limit', () => {
  test('authenticated API calls are limited per account, sync keeps its own budget', async () => {
    const server = await startTestServer({ ...LIMITED, RATE_LIMIT_API_PER_USER: '3' });
    try {
      const user = await register(server, 'busy@example.com');
      const me = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
      const vaultId = me.body.vaults[0].id as string;
      await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
      await api(server, 'GET', '/v1/devices', { token: user.accessToken });
      const limited = await api(server, 'GET', '/v1/account/me', { token: user.accessToken });
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, 'rate_limited');

      const pull = await api(server, 'GET', `/v1/sync/pull?vaultId=${encodeURIComponent(vaultId)}`, {
        token: user.accessToken,
      });
      assert.equal(pull.status, 200);
    } finally {
      await server.close();
    }
  });
});
