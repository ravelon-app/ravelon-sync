import nodemailer, { type Transporter } from 'nodemailer';

import type { Config } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { decryptSmtpPassword, readSetting } from '../lib/settings.js';

export interface ResolvedSmtp {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  user: string;
  password: string;
  from: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Resolves SMTP from the database first, then the environment.
 *
 * Both are supported on purpose: a container deployment configures mail
 * through env vars, and an operator who would rather click through the admin
 * interface can do that without redeploying.
 */
export async function resolveSmtp(db: AppDatabase, config: Config): Promise<ResolvedSmtp | null> {
  const stored = await readSetting(db, 'smtp');
  if (stored.enabled && stored.host) {
    return {
      host: stored.host,
      port: stored.port,
      security: stored.security,
      user: stored.user,
      password: decryptSmtpPassword(config.settingsEncryptionKey, stored.passwordEncrypted),
      from: stored.from || config.smtp.from,
    };
  }
  if (!config.smtp.host) return null;
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    security: config.smtp.security,
    user: config.smtp.user ?? '',
    password: config.smtp.password ?? '',
    from: config.smtp.from,
  };
}

/**
 * Sends one message, or reports why it could not be sent.
 *
 * Mail is never required for the server to work: without SMTP the admin
 * interface shows invite and reset links to copy by hand. So a failure here is
 * surfaced to the caller rather than thrown, and callers decide what to do.
 */
export async function sendMail(
  db: AppDatabase,
  config: Config,
  message: OutgoingMail,
): Promise<{ sent: boolean; reason?: string }> {
  const smtp = await resolveSmtp(db, config);
  if (!smtp) return { sent: false, reason: 'smtp_not_configured' };

  let transport: Transporter | undefined;
  try {
    transport = createTransport(smtp);
    await transport.sendMail({
      from: smtp.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : 'send_failed' };
  } finally {
    transport?.close();
  }
}

export function createTransport(smtp: ResolvedSmtp): Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Verifies a configuration without sending, for the admin interface's test button. */
export async function verifySmtp(smtp: ResolvedSmtp): Promise<{ ok: boolean; error?: string }> {
  const transport = createTransport(smtp);
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'verify_failed' };
  } finally {
    transport.close();
  }
}
