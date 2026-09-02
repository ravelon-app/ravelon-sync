# Security model

What this server protects, how, and what it does not protect against.

## The short version

Ravelon Sync stores ciphertext. Vault contents are encrypted on your devices
with an account secret the server never receives in the clear and cannot
derive: it holds only an envelope sealed under an Argon2id key that the device
derives from the account password, and a scrypt hash of that password from
which no such key can be rebuilt. Taking the server, or the database, or a
backup does not get anyone into a vault.

That is the whole design. Everything below is either how it is enforced or
where the boundary actually sits.

## What the server can see

| It sees | It cannot see |
| --- | --- |
| Email addresses and display names | Hostnames, usernames, passwords, SSH keys |
| Which records exist, and their type (`Host`, `Snippet`, …) | Anything inside a record |
| How large each encrypted record is | What makes it that size |
| When a record changed, and from which device | What changed |
| Team and vault membership | What is in a team's vault |

Record type and timing are metadata the sync protocol needs to order changes
and detect conflicts. An operator can tell that someone added twelve hosts on
Tuesday. They cannot tell what any of them are.

## Encryption

**Vault records.** Encrypted client-side before upload. The server stores the
ciphertext and nonce verbatim and returns them byte for byte. It never
inspects, normalises or re-encodes them.

**Vault key material.** Wrapped by the client, stored opaquely per account and
vault, then handed back to another device of the same account. For the personal
vault this is the account secret sealed under the account password
(`ravelon-account-key-v1`); for a Team Vault it is the sharing key sealed under
the account secret. A team member therefore cannot overwrite another member's
envelope. The server refuses to store anything whose field names suggest an
unwrapped secret (`masterPassword`, `privateKey`, `dek`, …), so a client bug
becomes a loud failure rather than a quiet leak.

**Plaintext guard.** A push whose ciphertext parses as JSON, or base64-decodes
to readable JSON, is rejected with `plaintext_sync_payload`. This exists
because the one catastrophic failure mode is a client that forgets to encrypt.

## Authentication

**Passwords.** scrypt with N=2^15, r=8, p=1 and a per-password 16-byte salt.
The parameters are stored inside the hash, so raising them later re-hashes on
next sign-in instead of invalidating every password. Minimum length is 10
characters, matching what the desktop client enforces before it calls the
server at all.

**Timing.** An unknown email address is verified against a fixed dummy hash, so
sign-in takes the same time whether or not the account exists. Password reset
requests answer identically either way. Neither endpoint can be used to
enumerate who has an account here.

**Access tokens.** HS256, 15 minutes by default, carrying the account, role and
device. Every authenticated request re-checks the database: a token stays
cryptographically valid for its full lifetime, but a disabled account or a
revoked device is refused immediately rather than at expiry.

**Refresh tokens.** Opaque, stored only as SHA-256 digests, rotated on every
use. Presenting a token that was already rotated is treated as compromise, not
as a retry: every session on that device is revoked and the person signs in
again. Two concurrent refreshes resolve to exactly one winner through a
conditional update.

**Two-factor.** TOTP, RFC 6238, SHA-1, 6 digits, 30-second period, ±1 step
tolerance. Secrets are encrypted with AES-256-GCM under a key derived from
`MFA_ENCRYPTION_KEY` for that purpose alone. The highest accepted time step is
recorded, so a code observed over the shoulder cannot be replayed inside its
own window. Recovery codes are shown once and stored as keyed HMAC digests, so
a stolen table cannot be brute-forced without the key.

**Re-authentication.** Turning off two-factor, replacing recovery codes,
deleting an account and approving a new device all require the password again,
and a current code where one is enrolled. A found unlocked session is not
enough to take an account over.

## Access control

Every vault and team route resolves membership from the database on each
request. A vault the caller is not a member of answers `vault_not_accessible`
whether or not it exists, so probing reveals nothing.

Removing someone from a team removes their membership in the team's vaults in
the same transaction. Records already decrypted on their device stay there;
that is unavoidable and is why removal is not a substitute for rotating
credentials the person actually used.

The last administrator cannot be demoted, disabled or deleted. Locking yourself
out of a server you own is not a recoverable state.

## Rate limiting

Per-IP limits on authentication routes, per-account lockout after repeated
failures, per-account limits on sync and general API calls. Counters live in
process, which is enough for the single-instance deployment this is built for.
Behind several replicas each enforces its own share, so put a limit on the
reverse proxy if that matters to you.

`TRUSTED_PROXY_IPS` must name your proxy exactly. Trusting every hop would let
any client set `X-Forwarded-For` and walk past every per-IP limit.

## Transport

Ravelon clients refuse anything but HTTPS, except on `127.0.0.1`. Run a reverse
proxy that terminates TLS. The server sets `no-store`, `nosniff`,
`no-referrer` and `DENY` framing on every response.

## Audit

Registration, sign-in, two-factor changes, password changes, invitations, role
changes, vault and team lifecycle, and administrator actions are logged with
actor, target, IP and timestamp. Detail fields carry counts and identifiers,
never ciphertext, tokens or password material. Retention is configurable and
defaults to a year.

## What this does not protect against

Being honest about the boundary matters more than the list above.

- **A compromised client.** Malware on a device that holds an unlocked vault
  reads the plaintext. Nothing the server does can help.
- **A weak account password.** The envelope holding the account secret is sealed
  under it, so it is the only thing between an attacker holding your ciphertext
  and your credentials. Choose accordingly.
- **A forgotten password with no signed-in device left.** A password reset lets
  you back into the account, not into the vault: the envelope stays sealed under
  the old password. Any device that still holds the secret re-seals it under the
  new password on its next sign-in. Without one, there is no recovery, not by
  you, not by an administrator, not by anyone. This is what "the server cannot
  read it" means.
- **A malicious operator, over time.** Someone controlling the server can
  observe metadata, and could serve a modified web interface to anyone using
  it. They still cannot decrypt existing records, and the desktop and iOS
  clients do not load code from the server at all.
- **Traffic analysis.** Record sizes and sync timing are visible to anyone who
  can see the traffic or the database.
- **A stolen device with a live session.** Revoke it from **Devices**. Do that
  before assuming the session is gone.

## Reporting a vulnerability

Please report privately rather than opening a public issue: use GitHub's
"Report a vulnerability" on the Security tab, or email the address in
[CONTRIBUTING.md](../CONTRIBUTING.md).

Include what you did, what happened, and what you expected. A proof of concept
helps. You will get an acknowledgement within a few days.

Out of scope: missing headers with no demonstrated impact, rate limits on
unauthenticated endpoints that are already limited, attacks requiring a
compromised client or a leaked account password, and anything requiring physical
access to an unlocked device.
