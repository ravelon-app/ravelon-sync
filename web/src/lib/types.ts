/** Shapes the API returns. Kept in one place so a route change breaks loudly. */

export type UserRole = "admin" | "user";
export type VaultRole = "owner" | "admin" | "editor" | "viewer";
export type TeamRole = "owner" | "admin" | "member";
export type RegistrationMode = "open" | "invite" | "domain" | "closed";

export interface PublicConfig {
  serverName: string;
  version: string;
  needsSetup: boolean;
  registrationMode: RegistrationMode;
  registrationOpen: boolean;
  allowedEmailDomains: string[];
  requireEmailVerification: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  passwordMinLength: number;
  /** Absent on older servers; treat that as "unknown" and keep the form. */
  emailDelivery?: boolean;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export interface Vault {
  id: string;
  name: string;
  kind: "personal" | "team";
  role: VaultRole;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount?: number;
  storageBytes?: number;
  cursor?: string;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole;
  ownerUserId: string;
  members: number;
  vaults: Vault[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  email: string;
  displayName: string | null;
  disabled: boolean;
  role: TeamRole;
  vaultRole: VaultRole;
  joinedAt: string;
}

export interface VaultMember {
  id: string;
  email: string;
  displayName: string | null;
  disabled: boolean;
  role: VaultRole;
  joinedAt: string;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  createdAt: string;
  mfaVerified: boolean;
  current?: boolean;
}

export interface AccountBundle {
  user: User;
  entitlements: { canSync: boolean; maxDevices: number | null; features: string[] };
  deployment: { kind: string; serverName: string; version: string };
  vaults: Vault[];
  mfaEnabled: boolean;
}

export interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  target: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AdminOverview {
  users: { total: number; admins: number; disabled: number; activeLastWeek: number };
  teams: number;
  vaults: number;
  syncItems: number;
  devices: number;
  encryptedBytes: number;
  recentActivity: Array<{
    id: string;
    action: string;
    target: string | null;
    actorEmail: string | null;
    createdAt: string;
  }>;
}

export interface AdminUser extends User {
  mfaEnabled: boolean;
  vaults: number;
  devices: number;
}

export interface AdminUserDetail extends User {
  mfaEnabled: boolean;
  vaults: Array<{ id: string; name: string; kind: string; role: VaultRole }>;
  teams: Array<{ id: string; name: string; role: TeamRole }>;
  devices: Array<{ id: string; name: string; platform: string; lastSeenAt: string | null; createdAt: string }>;
}

export interface AdminVault {
  id: string;
  name: string;
  kind: string;
  ownerEmail: string | null;
  teamName: string | null;
  members: number;
  items: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInvite {
  id: string;
  email: string;
  role: UserRole;
  note: string;
  status: "pending" | "used" | "revoked" | "expired";
  createdByEmail: string | null;
  usedByEmail: string | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface CreatedInvite {
  id: string;
  email: string;
  role: UserRole;
  note?: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  emailDelivered: boolean;
  emailError: string | null;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  email: string;
  role: TeamRole;
  vaultRole: VaultRole;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedTeamInvite extends TeamInvite {
  teamName: string;
  token: string;
  inviteUrl: string;
  emailDelivered: boolean;
  emailError: string | null;
}

export interface PlatformSettings {
  serverName: string;
  registrationMode: RegistrationMode;
  allowedEmailDomains: string[];
  requireEmailVerification: boolean;
  allowTeamCreation: boolean;
  auditRetentionDays: number;
  itemVersionsKept: number;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  user: string;
  from: string;
  passwordSet: boolean;
}

export interface AdminSettings {
  platform: PlatformSettings;
  smtp: SmtpSettings;
  environmentSmtpConfigured: boolean;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  nodeEnv: string;
  database: "sqlite" | "postgres";
  uptimeSeconds: number;
  publicUrl: string | null;
  smtpConfigured: boolean;
  limits: { vaultStorageBytes: number; vaultsPerUser: number };
  rateLimitEnabled: boolean;
  warnings: string[];
}

export interface PairingRequest {
  requestId: string;
  deviceName: string;
  platform: string;
  userCode: string;
  status: "pending" | "approved" | "consumed" | "expired";
  expiresAt: string;
}

export interface ItemVersion {
  id: string;
  itemType: string;
  schemaVersion: number;
  clientRevision: number;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
  restoredAt: string | null;
  storedAt: string;
  deviceId: string | null;
  reason: string;
}
