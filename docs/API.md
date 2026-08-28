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
still needs setup, and whether a sign-up form should exist.

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
  "inviteToken": "ain_..."
}
```

`201` with a session. The first account on a fresh deployment is always
allowed and becomes the administrator; after that the deployment's sign-up
policy applies, and an invitation overrides it.

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
| `POST /v1/auth/password/change` | Signs every other device out |
| `POST /v1/auth/password/reset/request` | Always answers identically |
| `POST /v1/auth/password/reset/confirm` | Revokes every session |
| `POST /v1/auth/verify-email/request` | Sends a confirmation link |
| `POST /v1/auth/verify-email/confirm` | Confirms an address |

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

### `POST /v1/sync/push`

```json
{
  "vaultId": "personal-vault",
  "items": [
    {
      "id": "host-1",
      "vaultId": "personal-vault",
      "itemType": "Host",
      "ciphertext": "b64:opaque-client-ciphertext",
      "nonce": "b64:xchacha20-poly1305-nonce",
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

`baseRevision` is optional. Present, it is a compare-and-swap. Absent, the
push falls back to last-writer-wins, which is what older clients rely on.

**Rejected:** ciphertext that parses as JSON, or base64-decodes to readable
JSON, gets `400 plaintext_sync_payload`.

### `GET /v1/sync/pull?vaultId=&cursor=`

```json
{ "cursor": "142", "hasMore": false, "items": [ … ] }
```

Up to 100 records per page, oldest first. Deletes come back as tombstones with
`deletedAt` set rather than as gaps, so a client that was offline learns about
them instead of resurrecting the record. Keep pulling while `hasMore`.

### `GET /v1/sync/events?vaultId=` (WebSocket)

```json
{ "type": "vaultChanged", "vaultId": "…", "cursor": "142" }
```

Only that. No record data crosses this socket. One message is sent on connect
so a client that reconnected after a restart notices a cursor it missed.

### Vault key material

`PUT /v1/vault/key-material` with `{ vaultId, material }`, and `GET` with
`?vaultId=`. Stored and returned verbatim for the authenticated account, so
different team members cannot overwrite each other's passphrase-wrapped
envelopes. Material whose field names suggest an unwrapped secret is refused
with `raw_vault_key_material`.

## Vaults and teams

| Route | Purpose |
| --- | --- |
| `GET /v1/vaults` | Vaults you can reach, with counts and storage |
| `POST /v1/vaults` | Create one |
| `PATCH /v1/vaults/:id` | Rename |
| `DELETE /v1/vaults/:id` | Delete, with its records |
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
quietly disagreeing about history.

## Device pairing

For a client with no comfortable way to type a password.

1. `POST /v1/desktop-auth/start` with `{ deviceName, platform }` → `requestId`,
   `pollToken`, `userCode`, `verificationUrl`
2. The person opens `verificationUrl` in a signed-in browser and confirms the
   `userCode` matches, plus their password and second factor
3. The client polls `POST /v1/desktop-auth/exchange` with `{ requestId, pollToken }`
   — `202 pending` until approval, then a session

Single-use, ten-minute expiry. Approval re-checks the password because it hands
a full session to a device that has not authenticated at all.

## Legacy snapshots

`GET`/`PUT /v1/desktop/vault`, `GET /v1/desktop/vault/status`, and
`GET /v1/desktop/vault/watch?vaultId=&afterVersion=` for clients older than the
granular protocol. `watch` is a long poll: it holds up to 50 seconds and
returns as soon as the vault changes, or immediately if the caller is already
behind. Uploads are compare-and-swap on `baseVersion`.

## Account and devices

| Route | Purpose |
| --- | --- |
| `GET /v1/account/me` | Account, entitlements, vaults |
| `PATCH /v1/account` | Display name |
| `GET /v1/account/export` | Everything held about you, records included |
| `DELETE /v1/account` | Permanent; needs the password again |
| `GET /v1/account/mfa` | Two-factor status |
| `POST /v1/account/mfa/totp/setup` | Start enrolment; needs the password |
| `POST /v1/account/mfa/totp/confirm` | Finish; returns recovery codes once |
| `GET /v1/devices` | Signed-in devices |
| `DELETE /v1/devices/:id` | Sign one out |

`entitlements.canSync` exists because Ravelon clients read it. Here it is true
unless the operator requires a confirmed email address.

## Administration

Every route needs `role=admin` and answers `403 admin_required` otherwise.

| Route | Purpose |
| --- | --- |
| `GET /v1/admin/overview` | Counts and recent activity |
| `GET /v1/admin/users` | Search and filter |
| `PATCH /v1/admin/users/:id` | Role, disable, verification |
| `POST /v1/admin/users/:id/password` | Set a password directly |
| `DELETE /v1/admin/users/:id/mfa` | Clear a lost second factor |
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
