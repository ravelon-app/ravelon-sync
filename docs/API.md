# API reference

The API a Ravelon client speaks, and what the web interface uses.

Base path `/v1`. JSON in, JSON out. Authenticated requests carry
`Authorization: Bearer <accessToken>`.

Errors are always the same shape:

```json
{ "error": { "code": "vault_not_accessible", "message": "Vault not found or not accessible" } }
```

## Discovery

### `GET /v1/health`

Unauthenticated. A Ravelon client calls this before it will talk to a server it
has not seen before.

```json
{
  "status": "ok",
  "service": "ravelon-sync",
  "version": "1.0.0",
  "officialBuild": false,
  "licenseStatus": "self-hosted",
  "serverName": "Acme Infrastructure",
  "registrationMode": "invite",
  "maintenanceMode": false,
  "capabilities": ["granularSync", "syncEvents", "vaultWatch", "teams", "mfa", "devicePairing", "legacySnapshots"]
}
```

`officialBuild: false` is what tells a client this is a community deployment
with no licence to check. A server that does not answer here cannot be added.

### `GET /v1/public-config`

What the web interface needs before anyone signs in: whether the deployment
still needs setup, whether a sign-up form should exist, and `emailDelivery`,
whether this server can send mail (the password-reset page offers a reset link
only when it can).

### `GET /healthz`

Liveness for Docker and Kubernetes. Touches the database.

## Authentication

### `POST /v1/auth/register`

```json
{
  "email": "someone@example.com",
  "password": "at-least-ten-characters",
  "displayName": "Someone",
  "deviceName": "Workstation",
  "platform": "desktop",
  "inviteToken": "ain_...",
  "teamInviteToken": "tin_..."
}
```

`201` with a session. The first account on a fresh deployment is always
allowed and becomes the administrator; after that the deployment's sign-up
policy applies, and an invitation overrides it.

`teamInviteToken` is a team invitation. It admits exactly the address it was
sent to, whatever the sign-up policy, and joins the team in the same step; the
response then carries its `teamId`. Another address answers
`403 invite_email_mismatch`, a spent or revoked invitation `404 invite_invalid`.

### `POST /v1/auth/login`

Same device fields. Send `mfaSupported: true` if the client can complete a
second factor; without it, an account with two-factor is refused rather than
let in.

`200` with a session, or `202` with a challenge:

```json
{ "mfaRequired": true, "challengeToken": "mch_...", "expiresAt": "2026-08-27T12:05:00.000Z" }
```

### `POST /v1/auth/mfa/verify`

`{ "challengeToken": "mch_...", "code": "123456" }` — a TOTP code or a recovery
code. Returns a session. The challenge is single-use.

### `POST /v1/auth/refresh`

`{ "refreshToken": "rft_..." }` → a new access token *and a new refresh token*.
The old one is dead. Presenting it again revokes the device, so store the new
one before using it.

### Other

| Route | Purpose |
| --- | --- |
| `POST /v1/auth/logout` | Revokes the device's sessions |
| `POST /v1/auth/password/change` | Signs every other device out; spends open reset links |
| `POST /v1/auth/password/reset/request` | Always answers identically, without waiting for mail |
| `POST /v1/auth/password/reset/confirm` | Revokes every session; spends other reset links |
| `POST /v1/auth/verify-email/request` | Sends a confirmation link |
| `POST /v1/auth/verify-email/confirm` | Confirms an address |

`password/change` takes `{ "currentPassword", "newPassword", "mfaCode"? }`. A
wrong current password answers `400 invalid_credentials`, not 401, so a client
does not mistake it for an expired access token. It shares the account's
reauthentication lockout, and a sent `mfaCode` is checked; it is not yet
required, because current desktop and iOS clients do not send one.

## Session shape

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "rft_...",
  "expiresIn": 900,
  "deviceId": "…",
  "userId": "…"
}
```

## Sync

The part that matters. The server never decrypts anything here.

Host protocols are client-side data inside the encrypted `Host` payload. This
includes VNC security mode (TLS/VeNCrypt or Apple Remote Desktop), certificate
server name, public CA certificates, SSH jump-host references and saved credentials.
The server must preserve ciphertext byte-for-byte and must not parse these fields.
No VNC-specific migration, environment variable, gateway or listener is needed.
Older clients must preserve host fields they do not understand; use an updated
client to edit VNC security settings.

### `POST /v1/sync/push`

```json
{
  "vaultId": "personal-vault",
  "items": [
    {
      "id": "host-1",
      "vaultId": "personal-vault",
      "itemType": "Host",
      "ciphertext": "opaque-client-ciphertext-in-base64",
      "nonce": "base64-nonce",
      "schemaVersion": 1,
      "clientRevision": 4,
      "baseRevision": 12,
      "updatedAt": "2026-07-02T12:00:00.000Z",
      "deletedAt": null
    }
  ]
}
```

Up to 500 items, 64 MiB. `itemType` is one of `Host`, `Group`, `Identity`,
`Snippet`, `PortForward`, `Preferences`, `IncidentCapsule`.

Each item is answered independently, because one stale record must not fail the
other 499:

```json
{
  "cursor": "142",
  "results": [{ "id": "host-1", "status": "stored", "revision": 142 }]
}
```

| Status | Meaning | What the client does |
| --- | --- | --- |
| `stored` | Written; `revision` is its new cursor | Record it |
| `unchanged` | Already identical | Nothing |
| `stale` | An older last-writer-wins push | Pull, then retry |
| `conflict` | `baseRevision` no longer matches | Merge against `current`, retry |

A `conflict` carries `current`, the server's version, because the client cannot
merge without it and the server cannot merge at all.

A push whose `baseRevision` names a record the server does not have (typically
after the database was restored from an older backup) is stored rather than
answered with a conflict: there is no newer copy to protect, and a conflict
without `current` is one no client can resolve.

`unchanged` requires the same ciphertext and nonce as well as the same
metadata, so a record re-encrypted under its old revision is still stored.

Current Ravelon clients encrypt with AES-256-GCM and send standard base64. The
server does not care which scheme a client uses; it only refuses plaintext.

`baseRevision` is optional. Present, it is a compare-and-swap. Absent, the
push falls back to last-writer-wins, which is what older clients rely on.

**Rejected:** ciphertext that parses as JSON, or base64-decodes to readable
JSON, gets `400 plaintext_sync_payload`.

### `GET /v1/sync/pull?vaultId=&cursor=`

```json
{ "cursor": "142", "hasMore": false, "items": [ … ] }
```

Up to 500 records or about 8 MiB of ciphertext per page, whichever comes first,
oldest first (a single larger record still gets a page of its own). Deletes
come back as tombstones with `deletedAt` set rather than as gaps, so a client
that was offline learns about them instead of resurrecting the record. Keep
pulling while `hasMore`.

A partial page reports its last record's cursor. The final page reports the
vault's head. A head lower than the cursor the client sent means the server was
restored from an older backup; the client should pull again from `0`.

### `GET /v1/sync/events?vaultId=` (WebSocket)

```json
{ "type": "vaultChanged", "vaultId": "…", "cursor": "142" }
```

Only that. No record data crosses this socket. One message is sent on connect
so a client that reconnected after a restart notices a cursor it missed.

Every 25 seconds the server pings each socket, which keeps reverse proxies from
cutting a quiet connection, and checks again that the device is still signed
in and still a member of the vault. Close codes:

| Code | Reason | Meaning |
| --- | --- | --- |
| `1008` | `unauthorized` | Token missing, invalid or expired, or the device was signed out. Refresh the session and reconnect. |
| `1008` | `vault_not_accessible` | No access to this vault, or access was removed. |
| `1008` | `email_verification_required` | The operator requires a confirmed address. |
| `1013` | `too_many_connections` | More than 32 sockets for one account. Reconnect later. |

### Vault key material

`PUT /v1/vault/key-material` with `{ vaultId, material, ifAbsent? }`, and
`GET` with `?vaultId=`. With `ifAbsent: true` the envelope is created only when
none exists and `409 key_material_exists` is answered otherwise, which is how
two first devices of one account settle on one secret. Stored and returned
verbatim for the authenticated account, so
different team members cannot overwrite each other's envelopes. Clients keep
two kinds here: for the personal vault, the account secret sealed under a key
derived from the account password (`{ version: 1, purpose:
"ravelon-account-key-v1", salt, nonce, ciphertext }`), and for a Team Vault the
sharing key sealed under the account secret. Material whose field names suggest
an unwrapped secret is refused with `raw_vault_key_material`.

## Vaults and teams

| Route | Purpose |
| --- | --- |
| `GET /v1/vaults` | Vaults you can reach, with counts and storage |
| `POST /v1/vaults` | Create one |
| `PATCH /v1/vaults/:id` | Rename |
| `DELETE /v1/vaults/:id` | Delete, with its records. The first personal vault holds the account key envelope and is refused with `409 personal_vault_required`. |
| `GET /v1/vaults/:id/members` | Who has access |
| `PATCH /v1/vaults/:id/members/:userId` | Change a role |
| `GET /v1/vaults/:id/items/:itemId/versions` | Version metadata |
| `POST /v1/vaults/:id/items/:itemId/restore` | Restore one forward |
| `GET /v1/teams` | Your teams |
| `POST /v1/teams` | Create a team and its first vault |
| `GET /v1/teams/:id/members` | Members |
| `POST /v1/teams/:id/invites` | Invite |
| `POST /v1/team-invites/:token/accept` | Accept |
| `POST /v1/teams/:id/transfer-ownership` | Hand over |

Vault roles: `owner`, `admin`, `editor`, `viewer`. Writing needs `editor` or
above. Team roles: `owner`, `admin`, `member`.

Restoring copies the stored blob *forward* as a new revision rather than
winding the cursor back, so every device pulls the restored state instead of
quietly disagreeing about history. Its client revision is raised above the copy
it replaces, so a device still holding that copy cannot overwrite the restore
by last writer wins.

## Device pairing

For a client with no comfortable way to type a password.

1. `POST /v1/desktop-auth/start` with `{ deviceName, platform }` → `requestId`,
   `pollToken`, `userCode`, `verificationUrl`
2. The person opens `verificationUrl` in a signed-in browser and confirms the
   `userCode` matches, plus their password and second factor
3. The client polls `POST /v1/desktop-auth/exchange` with `{ requestId, pollToken }`
   — `202 pending` until approval, then a session with `user` (the same shape
   as `/v1/account/me`), `entitlements` and `vaults`

Single-use, ten-minute expiry. Approval re-checks the password because it hands
a full session to a device that has not authenticated at all. Wrong passwords
and codes count toward the account lockout, after which approval answers
`429 too_many_attempts` until it expires.

## Legacy snapshots

`GET`/`PUT /v1/desktop/vault`, `GET /v1/desktop/vault/status`, and
`GET /v1/desktop/vault/watch?vaultId=&afterVersion=&afterCursor=` for clients
older than the granular protocol, and as a fallback when a WebSocket cannot be
held. Uploads are compare-and-swap on `baseVersion`.

`status` and `watch` answer `{ vaultId, exists, version, updatedAt, cursor }`,
where `cursor` is the vault's granular head as a string.

`watch` is a long poll: it holds up to 25 seconds and returns as soon as the
vault changes, or immediately if the caller is already behind. With
`afterCursor` the granular cursor decides whether the caller is behind; without
it the legacy snapshot `version` does. An account holds at most 16 of these
open at once; further ones answer immediately.

## Account and devices

| Route | Purpose |
| --- | --- |
| `GET /v1/account/me` | Account, entitlements, vaults |
| `PATCH /v1/account` | Display name |
| `GET /v1/account/export` | Everything held about you, records included |
| `DELETE /v1/account` | Permanent; needs the password again, `409 owns_teams` while it owns a team |
| `GET /v1/account/mfa` | Two-factor status |
| `POST /v1/account/mfa/totp/setup` | Start enrolment; needs the password |
| `POST /v1/account/mfa/totp/confirm` | Finish; returns recovery codes once |
| `POST /v1/account/mfa/recovery-codes` | Replace recovery codes; needs the password and a code |
| `GET /v1/devices` | Signed-in devices |
| `DELETE /v1/devices/:id` | Sign one out |

`entitlements.canSync` exists because Ravelon clients read it. Here it is true
unless a confirmed email address is required: when the operator turns that on,
and always under the `domain` sign-up policy.

## Administration

Every route needs `role=admin` and answers `403 admin_required` otherwise.

| Route | Purpose |
| --- | --- |
| `GET /v1/admin/overview` | Counts and recent activity |
| `GET /v1/admin/users` | Search and filter |
| `PATCH /v1/admin/users/:id` | Role, disable, verification |
| `POST /v1/admin/users/:id/password` | Set a password directly |
| `DELETE /v1/admin/users/:id/mfa` | Clear a lost second factor |
| `DELETE /v1/admin/users/:id` | Delete an account; `409 owns_teams` while it owns a team |
| `POST /v1/admin/invites` | Issue an invitation |
| `GET /v1/admin/vaults` | Metadata only, never ciphertext |
| `GET /v1/admin/audit` | Filterable audit log |
| `PUT /v1/admin/settings/platform` | Sign-up policy, retention, maintenance |
| `PUT /v1/admin/settings/smtp` | Mail; the password is never returned |
| `GET /v1/admin/system` | Version, database, and what needs attention |

## Status codes

| Code | Meaning |
| --- | --- |
| `400` | Validation failed, or a payload that should not exist |
| `401` | No session, or an expired or reused token |
| `403` | Signed in, but not allowed |
| `404` | Not found, or a token indistinguishable from one |
| `409` | Conflict: name taken, invitation spent, last administrator |
| `413` | Too large, or the vault quota is reached |
| `429` | Rate limited |
| `503` | Maintenance mode, writes only |
