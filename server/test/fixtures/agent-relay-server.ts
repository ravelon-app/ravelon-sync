import { api, register, startTestServer } from '../helpers.js';

// Disposable loopback fixture only. No real account, provider or durable data.
const server = await startTestServer({ PUBLIC_URL: `http://127.0.0.1:${process.env.PORT || '4311'}` });
const email = 'agent-relay-fixture@example.test';
const password = 'disposable-relay-fixture-only';
const account = await register(server, email, { password });
await api(server, 'PUT', '/v1/admin/settings/platform', {
  token: account.accessToken,
  body: { serverName: 'Agent relay fixture', registrationMode: 'open' },
});
const url = await server.app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || '4311') });
console.log(
  `Disposable relay: ${url}\nEmail: ${email}\nPassword: ${password}\nData is erased on exit. No provider credentials are needed.`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void server.close();
  });
