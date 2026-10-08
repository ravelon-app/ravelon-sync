import { newId, nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';

/**
 * Appends one line to the deployment audit trail.
 *
 * Detail is the operator's record of what happened, so it must never carry
 * ciphertext, tokens, password material or anything else the administrator is
 * not already entitled to read in the admin interface.
 */
export async function audit(
  db: AppDatabase,
  actorUserId: string | null,
  action: string,
  target: string | null,
  detail: Record<string, unknown> | null,
  ip: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, action, target, detail_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), actorUserId, action, target, detail ? JSON.stringify(detail) : null, ip, nowIso());
}

/** Removes audit lines older than the configured retention. */
export async function pruneAuditLog(db: AppDatabase, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
}
