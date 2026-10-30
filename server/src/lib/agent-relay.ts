import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';

export const RELAY_FRAME_BYTES = 1024 * 1024;
const FRAME_RATE = 30;
const BYTE_RATE = 8 * RELAY_FRAME_BYTES;
const BACKPRESSURE_BYTES = 2 * RELAY_FRAME_BYTES;
const uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const body = z.record(z.string(), z.unknown());
const controllerFrame = z.object({ type: z.literal('frame'), body }).strict();
const hostFrame = z.object({ type: z.literal('frame'), routeId: uuid, body }).strict();

export interface RelayIdentity {
  userId: string;
  deviceId: string;
}
interface Peer {
  socket: WebSocket;
  hostId: string;
  role: 'host' | 'controller';
  routeId: string;
  identity: RelayIdentity;
  authorize: () => Promise<void>;
  alive: boolean;
  windowStart: number;
  frames: number;
  bytes: number;
  pendingBytes: number;
  pendingFrames: number;
  tail: Promise<void>;
}

/** Live routing only. No message storage, retries, decryption or payload logging. */
export class AgentRelayHub {
  readonly #hosts = new Map<string, Peer>();
  readonly #controllers = new Map<string, Peer>();
  readonly #peers = new Set<Peer>();
  readonly #timer: NodeJS.Timeout;
  #checking = false;
  readonly #authorizationTimeoutMs: number;

  constructor(heartbeatMs = 25_000, authorizationTimeoutMs = 5000) {
    this.#authorizationTimeoutMs = authorizationTimeoutMs;
    this.#timer = setInterval(() => {
      void this.#sweep();
    }, heartbeatMs);
    this.#timer.unref();
  }

  online(hostId: string): boolean {
    return this.#hosts.get(hostId)?.socket.readyState === 1;
  }

  attach(
    socket: WebSocket,
    hostId: string,
    role: 'host' | 'controller',
    identity: RelayIdentity,
    authorize: () => Promise<void>,
  ): void {
    if (socket.readyState !== socket.OPEN) return;
    const host = this.#hosts.get(hostId);
    if (role === 'controller' && (!host || !this.online(hostId))) {
      this.#closeSocket(socket, 1008, 'host_offline');
      return;
    }
    if (role === 'controller' && this.#routes(hostId).length >= 8) {
      this.#closeSocket(socket, 1008, 'controller_limit');
      return;
    }
    if (role === 'host' && host) this.#drop(host, 1008, 'host_replaced');
    const peer: Peer = {
      socket,
      hostId,
      role,
      identity,
      authorize,
      routeId: randomUUID(),
      alive: true,
      windowStart: Date.now(),
      frames: 0,
      bytes: 0,
      pendingBytes: 0,
      pendingFrames: 0,
      tail: Promise.resolve(),
    };
    this.#peers.add(peer);
    if (role === 'host') this.#hosts.set(hostId, peer);
    else this.#controllers.set(peer.routeId, peer);
    socket.on('pong', () => {
      peer.alive = true;
    });
    socket.once('close', () => this.#remove(peer));
    socket.once('error', () => this.#drop(peer, 1008, 'connection_failed'));
    socket.on('message', (data: RawData, binary: boolean) => this.#receive(peer, data, binary));
    if (role === 'controller' && host) {
      this.#send(peer, { type: 'connected', routeId: peer.routeId, deviceId: identity.deviceId });
      this.#send(host, { type: 'controllerJoined', routeId: peer.routeId, deviceId: identity.deviceId });
    }
  }

  disconnectHost(hostId: string): void {
    const host = this.#hosts.get(hostId);
    if (host) this.#drop(host, 1008, 'host_removed');
  }

  close(): void {
    clearInterval(this.#timer);
    for (const peer of [...this.#peers]) this.#drop(peer, 1001, 'server_shutdown');
  }

  #receive(peer: Peer, raw: RawData, binary: boolean): void {
    if (!this.#active(peer)) return;
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    if (binary || data.length > RELAY_FRAME_BYTES) {
      this.#drop(peer, binary ? 1008 : 1009, binary ? 'invalid_frame' : 'frame_too_large');
      return;
    }
    const now = Date.now();
    if (now - peer.windowStart >= 1000) {
      peer.windowStart = now;
      peer.frames = 0;
      peer.bytes = 0;
    }
    peer.frames += 1;
    peer.bytes += data.length;
    if (peer.frames > FRAME_RATE || peer.bytes > BYTE_RATE) {
      this.#drop(peer, 1008, 'rate_limit');
      return;
    }
    if (peer.pendingFrames >= FRAME_RATE || peer.pendingBytes + data.length > BACKPRESSURE_BYTES) {
      this.#drop(peer, 1008, 'backpressure');
      return;
    }
    peer.pendingBytes += data.length;
    peer.pendingFrames += 1;
    peer.tail = peer.tail
      .then(async () => {
        if (!this.#active(peer)) return;
        const parsed: unknown = JSON.parse(data.toString('utf8'));
        const frame = peer.role === 'host' ? hostFrame.parse(parsed) : controllerFrame.parse(parsed);
        const target =
          peer.role === 'host'
            ? this.#controllers.get((frame as z.infer<typeof hostFrame>).routeId)
            : this.#hosts.get(peer.hostId);
        // A controller can disconnect while its host reply is still in flight.
        if (!target && peer.role === 'host') return;
        if (!target || target.hostId !== peer.hostId || target.identity.userId !== peer.identity.userId) {
          this.#drop(peer, 1008, 'route_not_accessible');
          return;
        }
        // Revalidate both endpoints. No await separates the final liveness check and send.
        const checks = await Promise.allSettled([this.#authorized(peer), this.#authorized(target)]);
        if (checks.some((check) => check.status === 'rejected')) return;
        if (!this.#active(peer) || !this.#active(target)) return;
        const forwarded =
          peer.role === 'host'
            ? { type: 'frame', body: frame.body }
            : { type: 'frame', routeId: peer.routeId, deviceId: peer.identity.deviceId, body: frame.body };
        const encoded = JSON.stringify(forwarded);
        if (Buffer.byteLength(encoded) > RELAY_FRAME_BYTES) {
          this.#drop(peer, 1009, 'frame_too_large');
          return;
        }
        this.#send(target, encoded);
      })
      .catch(() => this.#drop(peer, 1008, 'invalid_frame'))
      .finally(() => {
        peer.pendingBytes -= data.length;
        peer.pendingFrames -= 1;
      });
  }

  async #authorized(peer: Peer): Promise<void> {
    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          peer.authorize(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('authorization_timeout')),
              this.#authorizationTimeoutMs,
            );
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      this.#drop(peer, 1008, 'unauthorized');
      throw new Error('unauthorized');
    }
  }

  #send(peer: Peer, value: unknown): void {
    if (!this.#active(peer)) return;
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    if (peer.socket.bufferedAmount + Buffer.byteLength(encoded) > BACKPRESSURE_BYTES) {
      this.#drop(peer, 1008, 'backpressure');
      return;
    }
    peer.socket.send(encoded, (error) => {
      if (error) this.#drop(peer, 1008, 'connection_failed');
    });
  }

  #active(peer: Peer): boolean {
    return this.#peers.has(peer) && peer.socket.readyState === 1;
  }
  #routes(hostId: string): Peer[] {
    return [...this.#controllers.values()].filter((p) => p.hostId === hostId);
  }
  #remove(peer: Peer): void {
    if (!this.#peers.delete(peer)) return;
    if (peer.role === 'host' && this.#hosts.get(peer.hostId) === peer) {
      this.#hosts.delete(peer.hostId);
      for (const controller of this.#routes(peer.hostId)) this.#drop(controller, 1008, 'host_offline');
    } else if (peer.role === 'controller') {
      this.#controllers.delete(peer.routeId);
      const host = this.#hosts.get(peer.hostId);
      if (host) this.#send(host, { type: 'controllerLeft', routeId: peer.routeId });
    }
  }
  #drop(peer: Peer, code: number, reason: string): void {
    this.#remove(peer);
    this.#closeSocket(peer.socket, code, reason);
  }
  #closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState >= socket.CLOSING) return;
    socket.close(code, reason);
    const timer = setTimeout(() => {
      if (socket.readyState !== socket.CLOSED) socket.terminate();
    }, 1000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }
  async #sweep(): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;
    try {
      await Promise.all(
        [...this.#peers].map(async (peer) => {
          try {
            if (!peer.alive) {
              this.#drop(peer, 1008, 'heartbeat_timeout');
              return;
            }
            await this.#authorized(peer);
            if (!this.#active(peer)) return;
            peer.alive = false;
            peer.socket.ping();
          } catch {
            /* Authorization already closed the peer and any dependent routes. */
          }
        }),
      );
    } finally {
      this.#checking = false;
    }
  }
}
