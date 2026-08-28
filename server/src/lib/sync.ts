import { z } from 'zod';

import { newId, nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ApiError } from './errors.js';
import type { ExistingSyncItemRow, SyncItemRow } from './rows.js';

/**
 * Record types Ravelon clients synchronise.
 *
 * The server never decrypts a record, so this list is only a sanity check on
 * the metadata: it keeps a client from inventing types this deployment's
 * admin views and version pruning do not know about.
 */
export const SYNC_ITEM_TYPES = new Set([
  'Host',
  'Group',
  'Identity',
  'Snippet',
  'PortForward',
  'Preferences',
  'IncidentCapsule',
]);

export const SYNC_PULL_PAGE_SIZE = 100;
export const SYNC_PUSH_MAX_ITEMS = 500;

export const syncItemSchema = z.object({
  id: z.string().min(1).max(160),
  vaultId: z.string().min(1).max(160),
  itemType: z.string().min(1).max(40),
  ciphertext: z.string().min(1).max(1024 * 768),
  nonce: z.string().min(1).max(512),
  schemaVersion: z.number().int().positive(),
  clientRevision: z.number().int().nonnegative(),
  /**
   * Compare-and-swap guard. Present means "I based this edit on revision N";
   * the push is refused as a conflict if the server moved on. Absent falls
   * back to last-writer-wins, which older clients rely on.
   */
  baseRevision: z.number().int().nonnegative().optional(),
  // RFC 3339 allows both `Z` and an explicit offset. The Rust client emits
  // `+00:00` and Apple clients emit `Z`; accepting offsets keeps both working.
  updatedAt: z.iso.datetime({ offset: true }),
  deletedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export type SyncItemInput = z.infer<typeof syncItemSchema>;
export type SyncPushStatus = 'stored' | 'unchanged' | 'stale' | 'conflict';

export interface SyncPushResult {
  id: string;
  status: SyncPushStatus;
  revision?: number;
  current?: Record<string, unknown>;
}

/**
 * Rejects anything that is obviously not encrypted.
 *
 * A client bug that uploads plaintext would put real credentials on the
 * server, which is exactly what this design exists to prevent. Failing the
 * push loudly is better than storing it and discovering later.
 */
export function validateSyncItem(item: SyncItemInput, vaultId: string): void {
  if (item.vaultId !== vaultId) {
    throw new ApiError(400, 'vault_mismatch', 'Sync item vaultId must match the request vaultId');
  }
  if (!SYNC_ITEM_TYPES.has(item.itemType)) {
    throw new ApiError(400, 'invalid_item_type', `Unknown sync item type: ${item.itemType}`);
  }
  if (looksLikePlaintext(item.ciphertext)) {
    throw new ApiError(
      400,
      'plaintext_sync_payload',
      'ciphertext must be an opaque encrypted payload, not plaintext',
    );
  }
}

export function looksLikePlaintext(value: string): boolean {
  const trimmed = value.trim();
  if (isPlaintextJson(trimmed)) return true;
  const decoded = decodeMaybeBase64Text(trimmed);
  return decoded ? isPlaintextJson(decoded) : false;
}

function isPlaintextJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith('{')
    || trimmed.startsWith('[')
    || /"(password|hostname|privateKey|secret|username)"\s*:/i.test(trimmed)
  );
}

function decodeMaybeBase64Text(value: string): string | null {
  let raw = value.startsWith('b64:') ? value.slice(4).trim() : value;
  if (raw.length < 8 || raw.length > 1024 * 1024 || raw.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  raw = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
  try {
    const text = Buffer.from(padded, 'base64').toString('utf8').trim();
    if (!text || text.includes('�')) return null;
    const printable = [...text].filter(
      (character) => character === '\n'
        || character === '\r'
        || character === '\t'
        || (character >= ' ' && character <= '~'),
    ).length;
    return printable / text.length >= 0.85 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Orders two versions of the same record.
 *
 * The client revision decides; the timestamp only breaks a tie between two
 * devices that happened to reach the same revision number offline.
 */
export function compareRevision(
  leftRevision: number,
  leftUpdatedAt: string,
  rightRevision: number,
  rightUpdatedAt: string,
): number {
  if (leftRevision !== rightRevision) return leftRevision - rightRevision;
  return Date.parse(leftUpdatedAt) - Date.parse(rightUpdatedAt);
}

/** True when a push carries nothing new, so it can be acknowledged without a write. */
export function isUnchangedSyncItem(existing: ExistingSyncItemRow, item: SyncItemInput): boolean {
  return (
    existing.item_type === item.itemType
    && existing.schema_version === item.schemaVersion
    && existing.client_revision === item.clientRevision
    && existing.updated_at === item.updatedAt
    && (existing.deleted_at ?? null) === (item.deletedAt ?? null)
  );
}

/** Bytes a value occupies once stored, used for the per-vault storage quota. */
export function encodedBytes(...values: string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
}

/**
 * Deployment-wide monotonic counter.
 *
 * A single sequence across every vault means a client's cursor is a single
 * number, and `cursor > n` is a plain index scan.
 */
export async function nextCursor(db: AppDatabase): Promise<number> {
  await db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'sync_cursor'").run();
  const row = await db.prepare("SELECT value FROM counters WHERE name = 'sync_cursor'")
    .get<{ value: number }>();
  return Number(row?.value ?? 0);
}

export async function vaultCursor(db: AppDatabase, vaultId: string): Promise<number> {
  const row = await db.prepare(
    'SELECT COALESCE(MAX(cursor), 0) AS cursor FROM sync_items WHERE vault_id = ?',
  ).get<{ cursor: number }>(vaultId);
  return Number(row?.cursor ?? 0);
}

export interface InsertVersionInput {
  vaultId: string;
  itemId: string;
  itemType: string;
  ciphertext: string;
  nonce: string;
  schemaVersion: number;
  clientRevision: number;
  updatedAt: string;
  deletedAt: string | null;
  restoredAt: string | null;
  versionCursor: number;
  storedAt: string;
  actorUserId: string | null;
  deviceId: string | null;
  reason: string;
}

/** Appends a version and trims the record's history to `keep` entries. */
export async function insertSyncVersion(
  db: AppDatabase,
  input: InsertVersionInput,
  keep: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO sync_item_versions
      (id, vault_id, item_id, item_type, ciphertext, nonce, schema_version, client_revision,
       updated_at, deleted_at, restored_at, version_cursor, stored_at, actor_user_id, device_id,
       reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    input.vaultId,
    input.itemId,
    input.itemType,
    input.ciphertext,
    input.nonce,
    input.schemaVersion,
    input.clientRevision,
    input.updatedAt,
    input.deletedAt,
    input.restoredAt,
    input.versionCursor,
    input.storedAt,
    input.actorUserId,
    input.deviceId,
    input.reason,
    nowIso(),
  );

  // Trimming by id keeps the statement portable; a window function would be
  // faster but SQLite and PostgreSQL disagree on DELETE ... USING syntax.
  const survivors = await db.prepare(
    `SELECT id FROM sync_item_versions
     WHERE vault_id = ? AND item_id = ?
     ORDER BY version_cursor DESC
     LIMIT ?`,
  ).all<{ id: string }>(input.vaultId, input.itemId, keep);
  if (survivors.length < keep) return;
  const oldest = survivors[survivors.length - 1].id;
  const cutoff = await db.prepare('SELECT version_cursor FROM sync_item_versions WHERE id = ?')
    .get<{ version_cursor: number }>(oldest);
  if (!cutoff) return;
  await db.prepare(
    'DELETE FROM sync_item_versions WHERE vault_id = ? AND item_id = ? AND version_cursor < ?',
  ).run(input.vaultId, input.itemId, cutoff.version_cursor);
}

/** The wire shape of a stored record. Matches what Ravelon clients decode. */
export function publicSyncItem(row: SyncItemRow): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: row.item_id,
    vaultId: row.vault_id,
    itemType: row.item_type,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    schemaVersion: Number(row.schema_version),
    clientRevision: Number(row.client_revision),
    revision: Number(row.cursor),
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
  if (row.restored_at) item.restoredAt = row.restored_at;
  return item;
}
