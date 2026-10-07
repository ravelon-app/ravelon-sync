import type { OutgoingMail } from './mailer.js';

/**
 * Plain, self-contained messages.
 *
 * No remote images and no tracking pixels: a self-hosted deployment should not
 * leak who opened which mail to anyone, including the operator.
 */
interface TemplateContext {
  serverName: string;
  to: string;
}

export function accountInviteEmail(
  context: TemplateContext & { inviteUrl: string; invitedBy: string; expiresAt: string },
): OutgoingMail {
  const heading = `You have been invited to ${context.serverName}`;
  const body = [
    `${context.invitedBy} invited you to create an account on ${context.serverName}, a self-hosted Ravelon Sync server.`,
    `The invitation expires on ${formatDate(context.expiresAt)}.`,
  ];
  return {
    to: context.to,
    subject: heading,
    text: plain(heading, body, 'Create your account', context.inviteUrl),
    html: html(context.serverName, heading, body, 'Create your account', context.inviteUrl),
  };
}

export function teamInviteEmail(
  context: TemplateContext & { inviteUrl: string; teamName: string; invitedBy: string; expiresAt: string },
): OutgoingMail {
  const heading = `Join ${context.teamName}`;
  const body = [
    `${context.invitedBy} added you to the team "${context.teamName}" on ${context.serverName}.`,
    'Accepting gives you access to the team vaults you were granted. Vault contents stay end-to-end encrypted.',
    `The invitation expires on ${formatDate(context.expiresAt)}.`,
  ];
  return {
    to: context.to,
    subject: `${heading} on ${context.serverName}`,
    text: plain(heading, body, 'Accept invitation', context.inviteUrl),
    html: html(context.serverName, heading, body, 'Accept invitation', context.inviteUrl),
  };
}

export function passwordResetEmail(
  context: TemplateContext & { resetUrl: string; expiresAt: string },
): OutgoingMail {
  const heading = 'Reset your password';
  const body = [
    `Someone asked to reset the password for ${context.to} on ${context.serverName}.`,
    `The link expires on ${formatDate(context.expiresAt)}. If this was not you, no action is needed.`,
    'Your vault data stays encrypted with your sync passphrase, which this link cannot change or recover.',
  ];
  return {
    to: context.to,
    subject: `Reset your ${context.serverName} password`,
    text: plain(heading, body, 'Reset password', context.resetUrl),
    html: html(context.serverName, heading, body, 'Reset password', context.resetUrl),
  };
}

export function emailVerificationEmail(
  context: TemplateContext & { verifyUrl: string; expiresAt: string },
): OutgoingMail {
  const heading = 'Confirm your email address';
  const body = [
    `Confirm ${context.to} to finish setting up your account on ${context.serverName}.`,
    `The link expires on ${formatDate(context.expiresAt)}.`,
  ];
  return {
    to: context.to,
    subject: `Confirm your email for ${context.serverName}`,
    text: plain(heading, body, 'Confirm email', context.verifyUrl),
    html: html(context.serverName, heading, body, 'Confirm email', context.verifyUrl),
  };
}

export function testEmail(context: TemplateContext): OutgoingMail {
  const heading = 'SMTP is working';
  const body = [
    `This is a test message from ${context.serverName}.`,
    'Delivery is configured correctly. Invitations, password resets and verification mails will reach your users.',
  ];
  return {
    to: context.to,
    subject: `${context.serverName}: SMTP test`,
    text: plain(heading, body),
    html: html(context.serverName, heading, body),
  };
}

function plain(heading: string, body: string[], actionLabel?: string, actionUrl?: string): string {
  const lines = [heading, '', ...body];
  if (actionLabel && actionUrl) lines.push('', `${actionLabel}: ${actionUrl}`);
  return lines.join('\n');
}

function html(
  serverName: string,
  heading: string,
  body: string[],
  actionLabel?: string,
  actionUrl?: string,
): string {
  const paragraphs = body
    .map((line) => `<p style="margin:0 0 16px;line-height:1.6;color:#3f4a55;">${escapeHtml(line)}</p>`)
    .join('');
  const action =
    actionLabel && actionUrl
      ? `<p style="margin:24px 0 8px;">
         <a href="${escapeAttribute(actionUrl)}"
            style="display:inline-block;padding:12px 20px;background:#0b1117;color:#ffffff;
                   text-decoration:none;border-radius:8px;font-weight:600;">${escapeHtml(actionLabel)}</a>
       </p>
       <p style="margin:0;font-size:13px;color:#7a8590;word-break:break-all;">${escapeHtml(actionUrl)}</p>`
      : '';
  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:32px 16px;background:#f4f6f8;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e7ec;border-radius:12px;padding:32px;">
    <p style="margin:0 0 24px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#7a8590;">${escapeHtml(serverName)}</p>
    <h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:#0b1117;">${escapeHtml(heading)}</h1>
    ${paragraphs}
    ${action}
  </div>
</body></html>`;
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
