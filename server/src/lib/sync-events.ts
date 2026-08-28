import type { WebSocket } from 'ws';

export interface VaultChangedEvent {
  type: 'vaultChanged';
  vaultId: string;
  cursor: string;
}

type Waiter = (event: VaultChangedEvent) => void;

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
  readonly #waiters = new Map<string, Set<Waiter>>();

  subscribe(vaultId: string, socket: WebSocket): () => void {
    const sockets = this.#sockets.get(vaultId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.#sockets.set(vaultId, sockets);

    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      sockets.delete(socket);
      if (sockets.size === 0) this.#sockets.delete(vaultId);
    };
    socket.once('close', unsubscribe);
    socket.once('error', unsubscribe);
    return unsubscribe;
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
