import { randomBytes } from 'node:crypto';
import path from 'node:path';

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

export interface Config {
  /** Public product version, reported by /v1/health and the web interface. */
  version: string;
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  /** Exact reverse-proxy IPs/CIDRs Fastify may trust for forwarded client metadata. */
  trustedProxyIps: string[];
  databaseUrl?: string;
  databaseFile: string;
  /** HS256 secret for short-lived access tokens. */
  jwtSecret: string;
  /**
   * Stable key material that encrypts TOTP secrets and keys recovery-code
   * hashes. Kept separate from jwtSecret so rotating the JWT secret does not
   * force every account to re-enrol its authenticator.
   */
  mfaEncryptionKey: string;
  /** Stable key material for secrets stored in the settings table (SMTP password). */
  settingsEncryptionKey: string;
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
  /**
   * Public origin this deployment is reached at. Used for invite links,
   * password-reset links and the desktop pairing URL. Empty means the server
   * derives it per request, which is correct for a single-origin deployment.
   */
  publicUrl: string;
  /**
   * Extra browser origins allowed to call the API. The bundled web interface
   * is same-origin and never needs an entry here.
   */
  corsOrigins: string[];
  /** Directory the built web interface is served from. Empty disables serving it. */
  webRoot: string;
  smtp: {
    host?: string;
    port: number;
    security: SmtpSecurity;
    user?: string;
    password?: string;
    from: string;
  };
  limits: {
    /** Encrypted bytes one vault may hold. */
    vaultStorageBytes: number;
    /** Vaults one account may own. */
    vaultsPerUser: number;
  };
  rateLimit: {
    enabled: boolean;
    /** Requests per minute per IP on auth routes. */
    authPerIpPerMin: number;
    /** Failed sign-ins per account per 15 minutes before a lockout. */
    authFailPerAccount: number;
    /** Sync requests per minute per account. */
    syncPerUserPerMin: number;
    /** General authenticated requests per minute per account. */
    apiPerUserPerMin: number;
  };
}

export class ConfigError extends Error {}

const DEV_SECRET_PREFIX = 'dev-insecure-';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = normalizeNodeEnv(env.NODE_ENV);
  const production = nodeEnv === 'production';

  const jwtSecret = requiredSecret(env.SYNC_JWT_SECRET, 'SYNC_JWT_SECRET', production);
  // Both fall back to the JWT secret so a minimal .env still starts. In
  // production every one of them is checked for real entropy first.
  const mfaEncryptionKey = optionalSecret(env.MFA_ENCRYPTION_KEY, 'MFA_ENCRYPTION_KEY', production)
    ?? jwtSecret;
  const settingsEncryptionKey = optionalSecret(env.SETTINGS_ENCRYPTION_KEY, 'SETTINGS_ENCRYPTION_KEY', production)
    ?? mfaEncryptionKey;

  return {
    version: env.RAVELON_SYNC_VERSION?.trim() || '1.0.0',
    nodeEnv,
    port: integer(env.PORT, 4100),
    host: env.HOST?.trim() || '0.0.0.0',
    trustedProxyIps: list(env.TRUSTED_PROXY_IPS),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    databaseFile: env.DATABASE_FILE?.trim() || path.resolve('data/ravelon-sync.db'),
    jwtSecret,
    mfaEncryptionKey,
    settingsEncryptionKey,
    accessTokenTtlSec: integer(env.ACCESS_TOKEN_TTL_SEC, 15 * 60),
    refreshTokenTtlDays: integer(env.REFRESH_TOKEN_TTL_DAYS, 60),
    publicUrl: normalizeOrigin(env.PUBLIC_URL, 'PUBLIC_URL'),
    corsOrigins: list(env.CORS_ORIGINS).map((origin) => normalizeOrigin(origin, 'CORS_ORIGINS')),
    webRoot: env.WEB_ROOT === '' ? '' : path.resolve(env.WEB_ROOT?.trim() || 'public'),
    smtp: {
      host: env.SMTP_HOST?.trim() || undefined,
      port: integer(env.SMTP_PORT, 587),
      security: smtpSecurity(env.SMTP_SECURITY),
      user: env.SMTP_USER?.trim() || undefined,
      password: env.SMTP_PASSWORD || undefined,
      from: env.EMAIL_FROM?.trim() || 'Ravelon Sync <no-reply@localhost>',
    },
    limits: {
      vaultStorageBytes: integer(env.VAULT_STORAGE_LIMIT_MB, 256) * 1024 * 1024,
      vaultsPerUser: integer(env.VAULTS_PER_USER, 50),
    },
    rateLimit: {
      enabled: !boolean(env.RATE_LIMIT_DISABLED, false),
      authPerIpPerMin: integer(env.RATE_LIMIT_AUTH_PER_IP, 30),
      authFailPerAccount: integer(env.RATE_LIMIT_AUTH_FAILURES, 10),
      syncPerUserPerMin: integer(env.RATE_LIMIT_SYNC_PER_USER, 240),
      apiPerUserPerMin: integer(env.RATE_LIMIT_API_PER_USER, 600),
    },
  };
}

/**
 * A generated development secret is deliberately marked, so
 * `secretIsGenerated` can warn about it at startup and production can refuse
 * to start on one.
 */
function requiredSecret(value: string | undefined, name: string, production: boolean): string {
  const secret = value?.trim() ?? '';
  if (!secret) {
    if (production) {
      throw new ConfigError(
        `${name} is required in production. Generate one with: openssl rand -base64 48`,
      );
    }
    return `${DEV_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  }
  assertStrongSecret(secret, name, production);
  return secret;
}

function optionalSecret(value: string | undefined, name: string, production: boolean): string | undefined {
  const secret = value?.trim() ?? '';
  if (!secret) return undefined;
  assertStrongSecret(secret, name, production);
  return secret;
}

function assertStrongSecret(secret: string, name: string, production: boolean): void {
  if (!production) return;
  if (secret.length < 32) {
    throw new ConfigError(`${name} must be at least 32 characters. Generate one with: openssl rand -base64 48`);
  }
  if (new Set(secret).size < 8) {
    throw new ConfigError(`${name} looks like a placeholder. Generate one with: openssl rand -base64 48`);
  }
}

export function secretIsGenerated(secret: string): boolean {
  return secret.startsWith(DEV_SECRET_PREFIX);
}

function normalizeNodeEnv(value: string | undefined): Config['nodeEnv'] {
  const env = value?.trim();
  if (env === 'production' || env === 'test') return env;
  return 'development';
}

function smtpSecurity(value: string | undefined): SmtpSecurity {
  const raw = value?.trim().toLowerCase();
  return raw === 'tls' || raw === 'none' ? raw : 'starttls';
}

/**
 * Accepts one exact origin, so a stray path or query cannot end up inside a
 * generated invite link or a CORS allowlist entry.
 */
function normalizeOrigin(value: string | undefined, name: string): string {
  const raw = value?.trim().replace(/\/$/, '') ?? '';
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a full URL such as https://sync.example.com`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ConfigError(`${name} must be a bare origin such as https://sync.example.com`);
  }
  return url.origin;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function newId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
