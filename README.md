# Ravelon Sync

[![CI](https://github.com/ravelon-app/ravelon-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/ravelon-app/ravelon-sync/actions/workflows/ci.yml)
[![Docker image](https://github.com/ravelon-app/ravelon-sync/actions/workflows/docker.yml/badge.svg)](https://github.com/ravelon-app/ravelon-sync/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-hosted sync server for [Ravelon](https://ravelon.app), the SSH, SFTP and
agent workspace. Run it yourself, invite your team, and keep your connection
data on infrastructure you control.

The server stores ciphertext it cannot read. Hosts, credentials, SSH keys and
snippets are encrypted on your devices with an account secret that only ever
reaches the server sealed under a key derived from the account password on the
device. Running the server does not give you, or anyone who takes it, a way into
anybody's vault.

- One container, one port, one volume
- Accounts, teams and shared vaults
- Two-factor authentication with recovery codes
- Invitation, domain-restricted, open or closed sign-up, your choice
- A web interface for everything: no config files to edit after setup
- SQLite by default, PostgreSQL when you want it
- MIT licensed, no telemetry, no phone-home, no licence check

## Quick start

```bash
git clone https://github.com/ravelon-app/ravelon-sync.git
cd ravelon-sync
cp .env.example .env
./scripts/generate-secrets.sh
```

Paste the three generated secrets into `.env`, set `PUBLIC_URL` to the address
you will reach the server at, then:

```bash
docker compose up -d
```

Open the server in a browser. The first account you create becomes the
administrator, and sign-up closes behind it until you decide who else may join.

> Ravelon clients require HTTPS for anything except `127.0.0.1`. Put a reverse
> proxy with TLS in front of this, and set `TRUSTED_PROXY_IPS` to that proxy's
> address.

### Without Docker

Node.js 22 or newer:

```bash
npm install
npm run build
SYNC_JWT_SECRET=... MFA_ENCRYPTION_KEY=... SETTINGS_ENCRYPTION_KEY=... \
PUBLIC_URL=https://sync.example.com npm start
```

## Connecting a client

In the Ravelon desktop app: **Settings → Account & sync → Own server**, enter
your server URL, and sign in with your e-mail and password. iOS works the same
way. That is the whole setup: the encryption key is derived from the password
on the device, and the server only ever receives the sealed envelope.

The overview page in the web interface shows the exact URL to enter.

## How it protects your data

| | |
| --- | --- |
| **Vault contents** | Encrypted on your devices. The server sees an opaque blob and a record type, never a hostname, a password or a key. |
| **Account secret** | Random, generated on the first device. Stored here only inside an envelope sealed with Argon2id over the account password, which cannot be rebuilt from the stored scrypt hash. The password does reach the server at sign-in, so the guarantee is against data at rest, not against an operator hostile at that moment; see [SECURITY.md](docs/SECURITY.md). |
| **Passwords** | scrypt, N=2^15, per-password salt, parameters stored with the hash. |
| **Refresh tokens** | Rotated on every use and stored only as SHA-256 digests. Presenting a rotated token revokes the device. |
| **Authenticator secrets** | AES-256-GCM with a key derived for that purpose alone. |
| **Recovery codes** | Shown once. Only keyed HMAC digests are stored. |
| **Plaintext guard** | A push that looks like unencrypted JSON is refused, so a client bug cannot quietly put real credentials on the server. |

A push of plaintext is rejected rather than stored. An administrator can see
that a vault holds 340 records and 2 MB, and has no way to see what is in one:
the web interface offers no such view because the server has no such ability.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model, including what
this design does *not* protect against.

## The web interface

Everything an operator needs, without editing a file on the server:

- **Users** — invite, disable, promote, reset a password, clear a lost second factor
- **Invitations** — per-address or shareable links, with expiry, revocable
- **Vaults** — record counts and storage per vault, metadata only
- **Audit log** — every security-relevant action, filterable, with retention you set
- **Settings** — sign-up policy, SMTP, maintenance mode, retention, limits
- **System** — version, database, uptime, and a list of anything that needs attention

Members get their own vaults, teams, devices, account settings and two-factor
setup.

## Sign-up policies

| Mode | Who gets in |
| --- | --- |
| `invite` | Only people you send a link to. The default. |
| `domain` | Anyone with an address at a domain you list. |
| `open` | Anyone who can reach the server. |
| `closed` | Nobody. Your invitations still work. |

The first account on a fresh deployment always gets in, whatever the mode says.
There is nobody else who could let it in.

## Email is optional

Without SMTP the server is fully usable: invitations and password resets appear
as links in the admin interface for you to send however you like. Configure
SMTP from **Administration → Settings** when you want them delivered
automatically, and use the test button before relying on it.

## Documentation

- [Installation and deployment](docs/INSTALLATION.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Security model](docs/SECURITY.md)
- [API reference](docs/API.md)
- [Backup and restore](docs/BACKUP.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
npm install
npm run dev:server     # API on http://127.0.0.1:4100
npm run dev:web        # interface on http://localhost:5174, proxying the API
```

```bash
npm test               # server and web suites
npm run typecheck
npm run build
```

The server suite runs against in-memory SQLite and covers authentication,
sync conflict handling, team access, two-factor, device pairing and the admin
API. A change is not done until it passes.

## Compatibility

Speaks the protocol current Ravelon desktop and iOS clients already use:
granular per-record sync with compare-and-swap conflicts, cursor-based pulls,
WebSocket change events, browser-approved device pairing, and the legacy
snapshot endpoints older builds still rely on.

`GET /v1/health` reports `officialBuild: false`, which is how a client knows
this is a community deployment with no licence to check.

## Licence

MIT. See [LICENSE](LICENSE).

Ravelon Sync is the open-source server. It is not affiliated with, and carries
no support commitment from, the hosted service at ravelon.app.
