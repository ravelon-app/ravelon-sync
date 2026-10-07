import { z } from 'zod';

import { nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * How this deployment decides who may create an account.
 *
 * - `open`     anyone who reaches the server can register
 * - `invite`   an administrator issues a link per person
 * - `domain`   open, but only for the listed email domains
 * - `closed`   nobody registers; the administrator creates accounts
 *
 * The first account ever created is exempt: a fresh deployment has no
 * administrator to open the door, so the bootstrap account always gets in.
 */
export const registrationModeSchema = z.enum(['open', 'invite', 'domain', 'closed']);
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

export const platformSettingsSchema = z.object({
  /** Shown in the web interface and in emails, so an operator can name their server. */
  serverName: z.string().trim().min(1).max(80).default('Ravelon Sync'),
  registrationMode: registrationModeSchema.default('invite'),
  /** Lowercase domains accepted in `domain` mode. */
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().min(3).max(190)).max(50).default([]),
  /** Require a verified email address before an account can sync. */
  requireEmailVerification: z.boolean().default(false),
  /** Let members create teams. Off leaves team creation to administrators. */
  allowTeamCreation: z.boolean().default(true),
  /** Days of audit history kept. 0 keeps everything. */
  auditRetentionDays: z.number().int().min(0).max(3650).default(365),
  /** Encrypted versions kept per sync record for point-in-time recovery. */
  itemVersionsKept: z.number().int().min(1).max(200).default(50),
  /** Read-only mode for maintenance. Sign-in and reads stay up; writes are refused. */
  maintenanceMode: z.boolean().default(false),
  maintenanceMessage: z.string().trim().max(500).default(''),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = platformSettingsSchema.parse({});

/**
 * SMTP overrides an administrator can set from the web interface. Environment
 * variables provide the fallback, so a deployment can be configured either way.
 */
export const smtpSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().max(255).default(''),
  port: z.number().int().min(1).max(65535).default(587),
  security: z.enum(['starttls', 'tls', 'none']).default('starttls'),
  user: z.string().trim().max(255).default(''),
  /** Encrypted at rest; never returned to any client. */
  passwordEncrypted: z.string().default(''),
  from: z.string().trim().max(255).default(''),
});
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

export const DEFAULT_SMTP_SETTINGS: SmtpSettings = smtpSettingsSchema.parse({});

const SETTINGS_SCHEMAS = {
  platform: platformSettingsSchema,
  smtp: smtpSettingsSchema,
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMAS;

/**
 * Reads a settings row, falling back to defaults.
 *
 * A row that no longer parses (hand-edited, or written by a newer version that
 * was rolled back) yields defaults rather than taking the server down. For
 * `platform` that fails safe: the default registration mode is `invite`.
 */
export async function readSetting<K extends SettingKey>(
  db: AppDatabase,
  key: K,
): Promise<z.infer<(typeof SETTINGS_SCHEMAS)[K]>> {
  const row = (await db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key)) as
    | { value_json: string }
    | undefined;
  const schema = SETTINGS_SCHEMAS[key];
  if (!row) return schema.parse({}) as z.infer<(typeof SETTINGS_SCHEMAS)[K]>;
  try {
    return schema.parse(JSON.parse(row.value_json)) as z.infer<(typeof SETTINGS_SCHEMAS)[K]>;
  } catch {
    return schema.parse({}) as z.infer<(typeof SETTINGS_SCHEMAS)[K]>;
  }
}

export async function writeSetting<K extends SettingKey>(
  db: AppDatabase,
  key: K,
  value: z.infer<(typeof SETTINGS_SCHEMAS)[K]>,
  actorUserId: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by_user_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       updated_by_user_id = excluded.updated_by_user_id`,
    )
    .run(key, JSON.stringify(value), nowIso(), actorUserId);
}

const SMTP_PASSWORD_PURPOSE = 'settings:smtp-password';

export function encryptSmtpPassword(keyMaterial: string, password: string): string {
  return password ? encryptSecret(keyMaterial, SMTP_PASSWORD_PURPOSE, password) : '';
}

export function decryptSmtpPassword(keyMaterial: string, encrypted: string): string {
  if (!encrypted) return '';
  try {
    return decryptSecret(keyMaterial, SMTP_PASSWORD_PURPOSE, encrypted);
  } catch {
    // Wrong SETTINGS_ENCRYPTION_KEY, or a value copied between deployments.
    // Treated as unset so mail simply stops rather than the server crashing.
    return '';
  }
}
