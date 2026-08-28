export interface Migration {
  name: string;
  sql: string;
}

/**
 * Schema for a self-hosted Ravelon Sync deployment.
 *
 * Written in the subset of SQL that SQLite and PostgreSQL agree on, because a
 * deployment may run either. Timestamps are ISO 8601 strings in TEXT columns
 * and booleans are INTEGER 0/1, so both engines round-trip them identically.
 *
 * Never edit a migration that has shipped. Append a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    name: '001_initial',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web',
  last_seen_at TEXT,
  last_ip TEXT,
  mfa_verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_device ON refresh_tokens(device_id);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_teams_owner ON teams(owner_user_id);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  default_vault_role TEXT NOT NULL DEFAULT 'editor',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  vault_role TEXT NOT NULL DEFAULT 'editor',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_team_invites_team ON team_invites(team_id);
CREATE INDEX idx_team_invites_email ON team_invites(email);

CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal',
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_vaults_user ON vaults(user_id);
CREATE INDEX idx_vaults_team ON vaults(team_id);

CREATE TABLE vault_members (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);
CREATE INDEX idx_vault_members_user ON vault_members(user_id);

/* Server-opaque wrapped key material. The server stores and returns it
   verbatim and can never unwrap it: the wrapping key never leaves a client. */
CREATE TABLE vault_key_material (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  material_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

/* One encrypted record per synced object. ciphertext and nonce are opaque to
   this server; cursor is the deployment-wide monotonic sync ordering. */
CREATE TABLE sync_items (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  client_revision BIGINT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  restored_at TEXT,
  cursor BIGINT NOT NULL,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, item_id)
);
CREATE INDEX idx_sync_items_cursor ON sync_items(vault_id, cursor);

/* Bounded history so an accidental overwrite on one device stays recoverable.
   Still opaque ciphertext: a restore copies a stored blob forward. */
CREATE TABLE sync_item_versions (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  client_revision BIGINT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  restored_at TEXT,
  version_cursor BIGINT NOT NULL,
  stored_at TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id TEXT,
  reason TEXT NOT NULL DEFAULT 'sync_push',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sync_item_versions_item ON sync_item_versions(vault_id, item_id, version_cursor);

/* One client-encrypted snapshot per vault, for clients older than the
   granular protocol. New clients import it once and then stop using it. */
CREATE TABLE desktop_vault_blobs (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  blob TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE user_mfa (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_encrypted TEXT,
  totp_confirmed_at TEXT,
  /* Highest accepted TOTP time-step, so a code cannot be replayed. */
  last_totp_step BIGINT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);

CREATE TABLE mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mfa_challenges_user ON mfa_challenges(user_id);

/* Browser-approved pairing for desktop and mobile clients. */
CREATE TABLE desktop_auth_requests (
  id TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'desktop',
  status TEXT NOT NULL DEFAULT 'pending',
  user_code TEXT NOT NULL,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_desktop_auth_expiry ON desktop_auth_requests(expires_at);

/* Invitations to create an account on this deployment. An empty email means
   the link works for whoever holds it; a value locks it to that address. */
CREATE TABLE account_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  note TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_account_invites_state ON account_invites(used_at, revoked_at, expires_at);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);

CREATE TABLE email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_user_id);
CREATE INDEX idx_audit_log_target ON audit_log(target);

/* Deployment settings the administrator edits from the web interface.
   Values are JSON; secrets inside them are encrypted before they land here. */
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);
INSERT INTO counters (name, value) VALUES ('sync_cursor', 0);
`,
  },
  {
    // A team can contain accounts with different sync passphrases. Keeping one
    // envelope per vault let the last member overwrite every other member's
    // second-device bootstrap material. Existing rows belonged to the vault
    // creator, so preserve them for that account while changing the key.
    name: '002_user_scoped_vault_key_material',
    sql: `
CREATE TABLE vault_user_key_material (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);
CREATE INDEX idx_vault_user_key_material_user ON vault_user_key_material(user_id);

INSERT INTO vault_user_key_material (vault_id, user_id, material_json, updated_at)
SELECT material.vault_id, vaults.user_id, material.material_json, material.updated_at
FROM vault_key_material AS material
JOIN vaults ON vaults.id = material.vault_id;
`,
  },
];
