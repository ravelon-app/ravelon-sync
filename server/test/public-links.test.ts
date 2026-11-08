import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { MAX_LINKS_PER_USER } from '../src/routes/public-links.js';
import { api, register, startTestServer, type TestServer } from './helpers.js';

/** What the desktop uploads: a page sealed with AES-256-GCM, nonce first, tag last. */
function seal(page: object, key = randomBytes(32)): { sealed: string; key: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('ravelon-public-link-v1'));
  const body = Buffer.concat([cipher.update(JSON.stringify(page)), cipher.final(), cipher.getAuthTag()]);
  return { sealed: Buffer.concat([nonce, body]).toString('base64'), key };
}

const page = { v: 1, kind: 'thread', title: 'Fix the build', html: '<p>Done</p>' };

describe('public links', () => {
  let server: TestServer;

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

  test('a signed-in account shares a sealed page that anyone with the link can fetch until it is revoked', async () => {
    const owner = await register(server, 'owner@example.com');
    const { sealed } = seal(page);
    const created = await api(server, 'POST', '/v1/public-links', {
      token: owner.accessToken,
      body: { sealed, expiresInDays: 7 },
    });
    assert.equal(created.status, 201);
    const publicId = String(created.body.url).split('/p/')[1];
    assert.match(created.body.url, /^https:\/\/sync\.test\/p\/[A-Za-z0-9_-]{22}$/);
    const days = (Date.parse(created.body.expiresAt) - Date.parse(created.body.createdAt)) / 86_400_000;
    assert.equal(days, 7);

    // No account, no cookie: the sealed bytes, and nothing that opens them.
    const content = await api(server, 'GET', `/v1/public-links/content/${publicId}`);
    assert.equal(content.status, 200);
    assert.equal(content.body.sealed, sealed);
    assert.equal(Object.keys(content.body).sort().join(','), 'expiresAt,sealed');

    const listed = await api(server, 'GET', '/v1/public-links', { token: owner.accessToken });
    assert.deepEqual(
      listed.body.links.map((link: { id: string }) => link.id),
      [created.body.id],
    );
    assert.equal(JSON.stringify(listed.body).includes(sealed), false);

    const revoked = await api(server, 'DELETE', `/v1/public-links/${created.body.id}`, {
      token: owner.accessToken,
    });
    assert.equal(revoked.status, 204);
    const gone = await api(server, 'GET', `/v1/public-links/content/${publicId}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, 'link_not_found');
  });

  test('only the owner lists and revokes a link, and only a signed-in account creates one', async () => {
    const owner = await register(server, 'alice@example.com');
    const other = await register(server, 'mallory@example.com');
    const created = await api(server, 'POST', '/v1/public-links', {
      token: owner.accessToken,
      body: { sealed: seal(page).sealed, expiresInDays: 1 },
    });
    assert.equal(created.status, 201);

    const anonymous = await api(server, 'POST', '/v1/public-links', {
      body: { sealed: seal(page).sealed, expiresInDays: 1 },
    });
    assert.equal(anonymous.status, 401);
    const othersList = await api(server, 'GET', '/v1/public-links', { token: other.accessToken });
    assert.deepEqual(othersList.body.links, []);
    const othersRevoke = await api(server, 'DELETE', `/v1/public-links/${created.body.id}`, {
      token: other.accessToken,
    });
    assert.equal(othersRevoke.status, 404);
    const stillThere = await api(
      server,
      'GET',
      `/v1/public-links/content/${String(created.body.url).split('/p/')[1]}`,
    );
    assert.equal(stillThere.status, 200);
  });

  test('a page in the clear, a malformed body and an unknown expiry are refused', async () => {
    const owner = await register(server, 'careful@example.com');
    const clear = Buffer.from(JSON.stringify(page)).toString('base64');
    for (const [body, code] of [
      [{ sealed: clear, expiresInDays: 7 }, 'plaintext_refused'],
      [{ sealed: 'not base64!', expiresInDays: 7 }, 'invalid_link'],
      [{ sealed: randomBytes(8).toString('base64'), expiresInDays: 7 }, 'invalid_link'],
      [{ sealed: seal(page).sealed, expiresInDays: 365 }, 'validation_failed'],
      [{ sealed: seal(page).sealed, expiresInDays: 7, title: 'leak' }, 'validation_failed'],
    ] as const) {
      const response = await api(server, 'POST', '/v1/public-links', { token: owner.accessToken, body });
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(response.body.error.code, code);
    }
  });

  test('an expired link is neither served nor listed, and the cleanup deletes it', async () => {
    const owner = await register(server, 'later@example.com');
    const created = await api(server, 'POST', '/v1/public-links', {
      token: owner.accessToken,
      body: { sealed: seal(page).sealed, expiresInDays: 1 },
    });
    const past = new Date(Date.now() - 1000).toISOString();
    await server.db.prepare('UPDATE public_links SET expires_at = ? WHERE id = ?').run(past, created.body.id);
    const publicId = String(created.body.url).split('/p/')[1];
    assert.equal((await api(server, 'GET', `/v1/public-links/content/${publicId}`)).status, 404);
    const listed = await api(server, 'GET', '/v1/public-links', { token: owner.accessToken });
    assert.deepEqual(listed.body.links, []);

    const { deleteExpiredPublicLinks } = await import('../src/routes/public-links.js');
    await deleteExpiredPublicLinks(server.db, new Date().toISOString());
    const left = await server.db.prepare('SELECT id FROM public_links WHERE id = ?').get(created.body.id);
    assert.equal(left, undefined);
  });

  test('an account has a limit of links up at once', async () => {
    const owner = await register(server, 'busy@example.com');
    const { sealed } = seal(page);
    for (let index = 0; index < MAX_LINKS_PER_USER; index += 1) {
      const response = await api(server, 'POST', '/v1/public-links', {
        token: owner.accessToken,
        body: { sealed, expiresInDays: 1 },
      });
      assert.equal(response.status, 201);
    }
    const over = await api(server, 'POST', '/v1/public-links', {
      token: owner.accessToken,
      body: { sealed, expiresInDays: 1 },
    });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'link_limit_reached');
  });

  test('deleting the account deletes its links', async () => {
    const owner = await register(server, 'leaving@example.com');
    await api(server, 'POST', '/v1/public-links', {
      token: owner.accessToken,
      body: { sealed: seal(page).sealed, expiresInDays: 30 },
    });
    await server.db.prepare('DELETE FROM users WHERE id = ?').run(owner.userId);
    const left = await server.db
      .prepare('SELECT COUNT(*) AS n FROM public_links WHERE user_id = ?')
      .get<{ n: number }>(owner.userId);
    assert.equal(Number(left?.n), 0);
  });

  test('the shared page runs only its own script, and its frame neither loads nor runs anything', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/p/AAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/html/);
    const csp = String(response.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(String(response.headers['x-robots-tag']), /noindex/);
    // The page holds no data and loads its script from this server only.
    assert.match(response.body, /<script type="module" src="\/p\/viewer\.js"><\/script>/);
    assert.doesNotMatch(response.body, /<script>(?!<)/);

    const script = await server.app.inject({ method: 'GET', url: '/p/viewer.js' });
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers['content-type']), /javascript/);
    // The frame gets an empty sandbox: no scripts, forms, popups or same origin.
    assert.match(script.body, /setAttribute\('sandbox', ''\)/);
    assert.match(script.body, /srcdoc = page\.html/);
    assert.doesNotMatch(script.body, /allow-scripts|allow-same-origin|innerHTML/);

    // The interface keeps its own policy.
    const home = await server.app.inject({ method: 'GET', url: '/v1/health' });
    assert.match(String(home.headers['content-security-policy']), /default-src 'self'/);
  });

  test('opening links is limited per address', async () => {
    const limited = await startTestServer({ RATE_LIMIT_DISABLED: '0' });
    try {
      let status = 0;
      for (let index = 0; index < 130 && status !== 429; index += 1) {
        status = (await api(limited, 'GET', '/v1/public-links/content/AAAAAAAAAAAAAAAAAAAAAA')).status;
      }
      assert.equal(status, 429);
    } finally {
      await limited.close();
    }
  });
});
