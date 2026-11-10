import type { AppDatabase } from '../db/database.js';
import { ApiError } from './errors.js';

/** Durable, bounded sliding window. A row lock serializes each host across API replicas. */
export async function claimAttentionBudget(db: AppDatabase, hostKey: string): Promise<void> {
  await db.transaction(async () => {
    const timestamp = new Date().toISOString();
    await db
      .prepare('DELETE FROM agent_attention_limits WHERE updated_at <= ?')
      .run(new Date(Date.now() - 3_600_000).toISOString());
    await db
      .prepare(
        'INSERT INTO agent_attention_limits (host_key, times, updated_at) VALUES (?, ?, ?) ON CONFLICT(host_key) DO NOTHING',
      )
      .run(hostKey, '[]', timestamp);
    const row = await db
      .prepare(
        `SELECT times FROM agent_attention_limits WHERE host_key = ?${db.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
      )
      .get<{ times: string }>(hostKey);
    const now = Date.now();
    const times = (JSON.parse(row!.times) as number[]).filter((time) => time > now - 3_600_000);
    const wait = Math.max(
      0,
      (times.at(-1) ?? 0) + 10_000 - now,
      times.length >= 60 ? times[0] + 3_600_000 - now : 0,
    );
    if (wait > 0) {
      const error = new ApiError(429, 'attention_rate_limited', 'Try again shortly');
      error.retryAfterSeconds = Math.min(3600, Math.max(1, Math.ceil(wait / 1000)));
      throw error;
    }
    times.push(now);
    await db
      .prepare('UPDATE agent_attention_limits SET times = ?, updated_at = ? WHERE host_key = ?')
      .run(JSON.stringify(times), timestamp, hostKey);
  })();
}
