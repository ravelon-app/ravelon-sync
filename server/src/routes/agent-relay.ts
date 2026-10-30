import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { RelayIdentity } from '../lib/agent-relay.js';
import { AgentRelayHub } from '../lib/agent-relay.js';
import type { RouteContext } from './context.js';
import { ApiError } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import { agentRelayCapability } from '../lib/agent-relay-capability.js';

const uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const registration = z.object({ clientId: uuid, label: z.string().trim().min(1).max(120) }).strict();
const connection = z.object({ hostId: uuid, role: z.enum(['host', 'controller']) }).strict();
interface HostRow {
  id: string;
  user_id: string;
  device_id: string;
  client_id: string;
  label: string;
}

export function registerAgentRelayRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config } = context;
  const hub = new AgentRelayHub();
  app.addHook('preClose', async () => hub.close());
  const authenticate = (request: FastifyRequest) => requireAuth(db, config, request);
  const requireRelay = async (request: FastifyRequest) => {
    const auth = await authenticate(request);
    const capability = await agentRelayCapability(context, auth);
    if (!capability.canConnect)
      throw new ApiError(403, 'agent_relay_unavailable', 'Agent relay is not available for this account');
    return { auth, capability };
  };

  app.get('/v1/agents/capabilities', async (request) =>
    agentRelayCapability(context, await authenticate(request)),
  );
  app.post('/v1/agents/hosts', async (request) => {
    const { auth, capability } = await requireRelay(request);
    const input = registration.parse(request.body);
    const staleIds: string[] = [];
    const registered = await db.transaction(async () => {
      // Serialize quotas per account on PostgreSQL; SQLite transactions are already serialized.
      if (db.dialect === 'postgres')
        await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(auth.user.id);
      const stale = await db
        .prepare(`SELECT h.id FROM agent_relay_hosts h
        WHERE h.user_id = ? AND h.device_id NOT IN (SELECT r.device_id FROM refresh_tokens r
          WHERE r.user_id = ? AND r.revoked_at IS NULL AND r.expires_at > ?)`)
        .all<{ id: string }>(auth.user.id, auth.user.id, new Date().toISOString());
      for (const old of stale) {
        await db
          .prepare('DELETE FROM agent_relay_hosts WHERE id = ? AND user_id = ?')
          .run(old.id, auth.user.id);
        staleIds.push(old.id);
      }
      const existing = await db
        .prepare('SELECT * FROM agent_relay_hosts WHERE user_id = ? AND client_id = ?')
        .get<HostRow>(auth.user.id, input.clientId);
      if (existing) {
        if (existing.device_id !== auth.deviceId)
          throw new ApiError(403, 'host_owner_required', 'This host belongs to another device session');
        await db.prepare('UPDATE agent_relay_hosts SET label = ? WHERE id = ?').run(input.label, existing.id);
        return { id: existing.id, label: input.label, online: false };
      }
      const count = await db
        .prepare('SELECT COUNT(*) AS count FROM agent_relay_hosts WHERE user_id = ?')
        .get<{ count: number }>(auth.user.id);
      if (Number(count?.count ?? 0) >= capability.hostLimit)
        throw new ApiError(409, 'host_limit', 'Remove a registered host before adding another');
      const id = randomUUID();
      await db
        .prepare(
          'INSERT INTO agent_relay_hosts (id, user_id, device_id, client_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, auth.user.id, auth.deviceId, input.clientId, input.label, new Date().toISOString());
      return { id, label: input.label, online: false };
    })();
    for (const id of staleIds) hub.disconnectHost(id);
    return registered;
  });
  app.get('/v1/agents/hosts', async (request) => {
    const auth = await authenticate(request);
    const hosts = await db
      .prepare('SELECT * FROM agent_relay_hosts WHERE user_id = ? ORDER BY created_at, id')
      .all<HostRow>(auth.user.id);
    return { hosts: hosts.map((host) => ({ id: host.id, label: host.label, online: hub.online(host.id) })) };
  });
  app.delete('/v1/agents/hosts/:id', async (request, reply) => {
    const auth = await authenticate(request);
    const id = z.object({ id: uuid }).parse(request.params).id;
    const deleted = await db
      .prepare('DELETE FROM agent_relay_hosts WHERE id = ? AND user_id = ? AND device_id = ?')
      .run(id, auth.user.id, auth.deviceId);
    if (!deleted.changes) throw new ApiError(404, 'host_not_found', 'Host not found or not accessible');
    hub.disconnectHost(id);
    return reply.code(204).send();
  });
  app.get('/v1/agents/relay', { websocket: true }, (socket, request) => {
    // Install the listener synchronously. A peer cannot race setup with early commands.
    const rejectEarly = () => socket.close(1008, 'not_connected');
    socket.on('message', rejectEarly);
    const deadline = setTimeout(() => socket.close(1008, 'authorization_timeout'), 5000);
    deadline.unref();
    socket.once('close', () => clearTimeout(deadline));
    void (async () => {
      const origin = request.headers.origin;
      const allowed = [
        config.publicUrl,
        ...config.corsOrigins,
        'tauri://localhost',
        'http://tauri.localhost',
      ];
      if (origin && !allowed.includes(origin)) throw new Error('origin');
      const query = connection.parse(request.query);
      const { auth } = await requireRelay(request);
      const identity: RelayIdentity = { userId: auth.user.id, deviceId: auth.deviceId };
      const authorize = async () => {
        const current = await requireRelay(request);
        if (current.auth.user.id !== identity.userId || current.auth.deviceId !== identity.deviceId)
          throw new Error('identity');
        const host = await db
          .prepare('SELECT * FROM agent_relay_hosts WHERE id = ? AND user_id = ?')
          .get<HostRow>(query.hostId, identity.userId);
        if (!host || (query.role === 'host' && host.device_id !== identity.deviceId)) throw new Error('host');
        // A host whose owner session died is not available to controllers either.
        const live = await db
          .prepare(
            'SELECT id FROM refresh_tokens WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
          )
          .get(host.device_id, host.user_id, new Date().toISOString());
        if (!live) throw new Error('host_session');
      };
      await authorize();
      socket.removeListener('message', rejectEarly);
      hub.attach(socket, query.hostId, query.role, identity, authorize);
    })()
      .catch(() => socket.close(1008, 'unauthorized'))
      .finally(() => clearTimeout(deadline));
  });
}
