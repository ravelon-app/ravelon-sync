/** Row shapes as they come back from the database, snake_case and untyped booleans. */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_verified: number;
  role: string;
  disabled: number;
  disabled_reason: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  last_seen_at: string | null;
  last_ip: string | null;
  mfa_verified_at: string | null;
  created_at: string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
  created_at: string;
}

export interface TeamRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export type TeamRole = 'owner' | 'admin' | 'member';
export type VaultRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface TeamAccessRow extends TeamRow {
  member_role: TeamRole;
  default_vault_role: VaultRole;
}

export interface VaultRow {
  id: string;
  user_id: string;
  name: string;
  kind: 'personal' | 'team';
  team_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VaultAccessRow extends VaultRow {
  member_role: VaultRole;
}

export interface SyncItemRow {
  vault_id: string;
  item_id: string;
  item_type: string;
  ciphertext: string;
  nonce: string;
  schema_version: number;
  client_revision: number;
  updated_at: string;
  deleted_at: string | null;
  restored_at: string | null;
  cursor: number;
  stored_at: string;
}

export interface ExistingSyncItemRow extends SyncItemRow {
  ciphertext_size: number;
  nonce_size: number;
}

export interface AccountInviteRow {
  id: string;
  token_hash: string;
  email: string;
  role: string;
  note: string;
  created_by_user_id: string | null;
  expires_at: string;
  used_at: string | null;
  used_by_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface TeamInviteRow {
  id: string;
  team_id: string;
  email: string;
  role: TeamRole;
  vault_role: VaultRole;
  token_hash: string;
  invited_by_user_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface MfaChallengeRow {
  id: string;
  user_id: string;
  challenge_hash: string;
  device_name: string;
  platform: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface UserMfaRow {
  user_id: string;
  totp_secret_encrypted: string | null;
  totp_confirmed_at: string | null;
  last_totp_step: number | null;
  created_at: string;
  updated_at: string;
}
