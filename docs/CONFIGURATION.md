# Configuration reference

Environment variables configure the deployment. Everything an operator changes
day to day lives in the web interface instead, under
**Administration → Settings**.

## Required in production

| Variable | Notes |
| --- | --- |
| `SYNC_JWT_SECRET` | Signs access tokens. At least 32 bytes. Changing it signs everyone out. |
| `PUBLIC_URL` | The exact origin people reach this server at, no path. Invitation and reset links are built from it. |

`MFA_ENCRYPTION_KEY` and `SETTINGS_ENCRYPTION_KEY` fall back to
`SYNC_JWT_SECRET`, which starts the server but couples them: rotating the JWT
secret would then invalidate every enrolled authenticator. Set all three.

In development, omitted secrets are generated at boot. The server warns, and
the System page says so, because every restart signs all clients out.

## Network

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4100` | |
| `HOST` | `0.0.0.0` | |
| `TRUSTED_PROXY_IPS` | empty | Exact proxy IPs or CIDRs, comma separated. Only these may report the client address. |
| `CORS_ORIGINS` | empty | Extra browser origins. The bundled interface is same-origin and needs none. |
| `WEB_ROOT` | `public` | Where the built interface lives. Empty serves the API only. |

`TRUSTED_PROXY_IPS` is worth getting right. Empty means every request looks
like it came from the proxy, so per-IP rate limits count the proxy. Trusting
everything is worse: any client could then forge its own address and walk past
those limits entirely.

## Database

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_FILE` | `./data/ravelon-sync.db` | SQLite, in WAL mode. |
| `DATABASE_URL` | unset | PostgreSQL. Takes precedence when set. |

SQLite is fine for one instance and a small team. PostgreSQL is for replicas,
or for folding this into an existing backup story.

## Email

Optional. Without it the server works fully; invitations and resets become
links you copy from the admin interface.

| Variable | Default |
| --- | --- |
| `SMTP_HOST` | empty |
| `SMTP_PORT` | `587` |
| `SMTP_SECURITY` | `starttls` (`tls`, `none`) |
| `SMTP_USER` | empty |
| `SMTP_PASSWORD` | empty |
| `EMAIL_FROM` | `Ravelon Sync <no-reply@localhost>` |

Settings saved in the web interface take precedence over these, and store the
password encrypted with `SETTINGS_ENCRYPTION_KEY`.

## Limits

| Variable | Default | Notes |
| --- | --- | --- |
| `VAULT_STORAGE_LIMIT_MB` | `256` | Encrypted bytes one vault may hold, versions included. |
| `VAULTS_PER_USER` | `50` | |
| `ACCESS_TOKEN_TTL_SEC` | `900` | |
| `REFRESH_TOKEN_TTL_DAYS` | `60` | How long an idle device stays signed in. |

## Rate limiting

| Variable | Default | Notes |
| --- | --- | --- |
| `RATE_LIMIT_DISABLED` | `false` | Leave it. Off removes brute-force protection on sign-in. |
| `RATE_LIMIT_AUTH_PER_IP` | `30` | Auth requests per minute per IP. |
| `RATE_LIMIT_AUTH_FAILURES` | `10` | Failures per account per 15 minutes before lockout. |
| `RATE_LIMIT_SYNC_PER_USER` | `240` | |
| `RATE_LIMIT_API_PER_USER` | `600` | |

## Settings in the web interface

These live in the database and change without a restart.

| Setting | Default | |
| --- | --- | --- |
| Server name | `Ravelon Sync` | Shown everywhere, and in mail. |
| Sign-up policy | `invite` | `open`, `invite`, `domain`, `closed`. |
| Allowed domains | empty | For `domain` mode. |
| Require confirmed email | off | Needs working mail. Test SMTP first. |
| Let members create teams | on | Off leaves team creation to administrators. |
| Audit retention | `365` days | `0` keeps everything. |
| Versions per record | `50` | How far back a record can be restored. |
| Maintenance mode | off | Refuses writes. Sign-in and reads stay up. |

## Sign-up policies

| Mode | Who gets in |
| --- | --- |
| `open` | Anyone who can reach the server. |
| `invite` | Only people holding a link you issued. The default. |
| `domain` | Anyone with an address at a listed domain. |
| `closed` | Nobody through the form. Your invitations still work. |

The first account on a fresh deployment is always allowed, whatever the mode
says: there is nobody else who could permit it.

`closed` removes the public form, not administrator invitations. That is what
makes it usable as "I create every account by hand".
