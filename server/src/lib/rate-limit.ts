import type { Config } from '../config.js';
import { ApiError } from './errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-process counters.
 *
 * A self-hosted deployment is normally one instance, so this is enough to stop
 * credential stuffing and runaway clients. Behind several replicas each one
 * enforces its own share; put a rate limit on the reverse proxy if that
 * matters for your deployment.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #failures = new Map<string, Bucket>();
  #lastSweep = Date.now();

  constructor(private readonly config: Config) {}

  /** Counts one request against `key`, throwing 429 past `limit` per minute. */
  hit(key: string, limit: number): void {
    if (!this.config.rateLimit.enabled) return;
    this.#sweep();
    const now = Date.now();
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again in a minute');
    }
  }

  /** True once an account or challenge has failed too often to keep trying. */
  isLockedOut(key: string): boolean {
    if (!this.config.rateLimit.enabled) return false;
    const bucket = this.#failures.get(key);
    return Boolean(
      bucket && bucket.resetAt > Date.now() && bucket.count >= this.config.rateLimit.authFailPerAccount,
    );
  }

  recordFailure(key: string): void {
    if (!this.config.rateLimit.enabled) return;
    const now = Date.now();
    const bucket = this.#failures.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.#failures.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return;
    }
    bucket.count += 1;
  }

  clearFailures(key: string): void {
    this.#failures.delete(key);
  }

  /** Drops expired buckets so a long uptime with many keys cannot grow forever. */
  #sweep(): void {
    const now = Date.now();
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
    for (const [key, bucket] of this.#failures) {
      if (bucket.resetAt <= now) this.#failures.delete(key);
    }
  }
}
