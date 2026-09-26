import type { WebSocket } from 'ws';

export interface VaultChangedEvent {
  type: 'vaultChanged';
  vaultId: string;
  cursor: string;
}

type Waiter = (event: VaultChangedEvent) => void;

/**
 * Answers whether a subscribed socket may stay open.
 *
 * Returns null while access holds, or the close reason to send once it does
 * not (a revoked device, a removed member, a deleted vault).
 */
export type SocketRevalidator = () => Promise<string | null>;

interface Subscription {
  vaultId: string;
  userId: string | null;
  revalidate: SocketRevalidator | null;
  unsubscribe: () => void;
}

/**
 * How often sockets are pinged and their access checked again.
 *
 * Below the idle timeout of common reverse proxies (nginx defaults to 60 s),
 * so a quiet but healthy socket is not cut, and short enough that access
 * removed from a member stops their notifications within half a minute.
 */
export const SOCKET_HEARTBEAT_MS = 25_000;

/**
 * Sockets one account may hold at once. A client holds one per watched vault;
 * the limit only stops a runaway client from exhausting the process.
 */
export const MAX_SOCKETS_PER_USER = 32;

/**
 * Process-local fan-out to clients waiting on a vault.
 *
 * The database cursor stays the source of truth; a delivered event is only a
 * hint to pull sooner. Losing one across a restart is harmless, because every
 * client resumes from its own persisted cursor.
 *
 * Two delivery paths exist because Ravelon clients differ: current desktop and
 * iOS builds hold a WebSocket, while older ones long-poll `/v1/desktop/vault/watch`.
 */
export class SyncEventHub {
  readonly #sockets = new Map<string, Set<WebSocket>>();
  readonly #subscriptions = new Map<WebSocket, Subscription>();
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #heartbeatMs: number;
  #heartbeat: NodeJS.Timeout | null = null;
  #sweeping = false;

  constructor(options: { heartbeatMs?: number } = {}) {
    this.#heartbeatMs = options.heartbeatMs ?? SOCKET_HEARTBEAT_MS;
  }

  /** Number of sockets `userId` currently holds, across all vaults. */
  socketsFor(userId: string): number {
    let count = 0;
    for (const [socket, subscription] of this.#subscriptions) {
      // A socket in its closing handshake no longer receives anything and
      // must not count against the account while the peer takes its time.
      if (subscription.userId === userId && socket.readyState === socket.OPEN) count += 1;
    }
    return count;
  }

  subscribe(
    vaultId: string,
    socket: WebSocket,
    options: { userId?: string; revalidate?: SocketRevalidator } = {},
  ): () => void {
    const sockets = this.#sockets.get(vaultId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.#sockets.set(vaultId, sockets);
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      sockets.delete(socket);
      this.#subscriptions.delete(socket);
      if (sockets.size === 0 && this.#sockets.get(vaultId) === sockets) this.#sockets.delete(vaultId);
    };
    this.#subscriptions.set(socket, {
      vaultId,
      userId: options.userId ?? null,
      revalidate: options.revalidate ?? null,
      unsubscribe,
    });
    this.#startHeartbeat();
    socket.once('close', unsubscribe);
    socket.once('error', unsubscribe);
    return unsubscribe;
  }

  /**
   * One heartbeat: ping every open socket and close those whose access is gone.
   *
   * A socket is authorized once, at connect. Without this a device signed out
   * or a member removed from a team vault would keep learning when that vault
   * changes for as long as the connection stayed up. The ping also keeps
   * reverse proxies from dropping an idle but healthy connection.
   */
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (const [socket, subscription] of [...this.#subscriptions]) {
        if (socket.readyState !== socket.OPEN) continue;
        try {
          socket.ping();
        } catch {
          // A socket that cannot be pinged is closing; its close event cleans up.
        }
        if (!subscription.revalidate) continue;
        let reason: string | null;
        try {
          reason = await subscription.revalidate();
        } catch {
          // Fail closed: if access cannot be confirmed, the socket does not stay.
          reason = 'sync_event_check_failed';
        }
        if (reason && socket.readyState === socket.OPEN) {
          socket.close(1008, reason);
          // Stop delivering right away rather than when the peer finishes the
          // closing handshake, which a stalled client may never do.
          subscription.unsubscribe();
        }
      }
    } finally {
      this.#sweeping = false;
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat || this.#heartbeatMs <= 0) return;
    this.#heartbeat = setInterval(() => {
      void this.sweep();
    }, this.#heartbeatMs);
    // The heartbeat must never keep the process alive past shutdown.
    this.#heartbeat.unref?.();
  }

  /** Resolves on the next change to `vaultId`, or with null once `timeoutMs` passes. */
  async wait(vaultId: string, timeoutMs: number): Promise<VaultChangedEvent | null> {
    return await new Promise<VaultChangedEvent | null>((resolve) => {
      const waiters = this.#waiters.get(vaultId) ?? new Set<Waiter>();
      this.#waiters.set(vaultId, waiters);

      let settled = false;
      const finish = (event: VaultChangedEvent | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(vaultId);
        resolve(event);
      };
      const waiter: Waiter = (event) => finish(event);
      const timer = setTimeout(() => finish(null), timeoutMs);
      // A long-poll must never hold the process open past shutdown.
      timer.unref?.();
      waiters.add(waiter);
    });
  }

  publish(event: VaultChangedEvent): void {
    const sockets = this.#sockets.get(event.vaultId);
    if (sockets) {
      const payload = JSON.stringify(event);
      for (const socket of [...sockets]) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        } else {
          sockets.delete(socket);
        }
      }
      if (sockets.size === 0) this.#sockets.delete(event.vaultId);
    }

    const waiters = this.#waiters.get(event.vaultId);
    if (waiters) {
      for (const waiter of [...waiters]) waiter(event);
    }
  }

  close(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#subscriptions.clear();
    for (const sockets of this.#sockets.values()) {
      for (const socket of sockets) socket.close(1001, 'Server shutting down');
    }
    this.#sockets.clear();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter({ type: 'vaultChanged', vaultId: '', cursor: '0' });
      }
    }
    this.#waiters.clear();
  }
}
