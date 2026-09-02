# Installation

From nothing to a working server, in the order you actually do it.

## Before you start

- A machine that can run Docker, or Node.js 22 or newer
- A domain pointing at it
- A reverse proxy that terminates TLS

That last one is not optional for a public deployment. Ravelon clients refuse
plain HTTP for anything except `127.0.0.1`, on purpose.

## 1. Get the code and generate secrets

```bash
git clone https://github.com/ravelon-app/ravelon-sync.git
cd ravelon-sync
cp .env.example .env
./scripts/generate-secrets.sh
```

Paste the three printed values into `.env`, replacing the empty ones.

They are not interchangeable and they are not recoverable:

| Secret | Losing it costs you |
| --- | --- |
| `SYNC_JWT_SECRET` | Everyone is signed out. Annoying, not fatal. |
| `MFA_ENCRYPTION_KEY` | Every account must enrol its authenticator again. |
| `SETTINGS_ENCRYPTION_KEY` | The stored SMTP password must be re-entered. |

Back them up wherever you back up the database. A database without
`MFA_ENCRYPTION_KEY` leaves everyone with two-factor unable to sign in.

## 2. Set the public URL

```dotenv
PUBLIC_URL=https://sync.example.com
```

Invitation links, password resets and device pairing URLs are built from this.
Get it wrong and people receive links that go nowhere.

## 3. Start it

```bash
docker compose up -d
docker compose logs -f sync
```

The container binds to `127.0.0.1:4100` by default, because the reverse proxy
is what should face the internet.

Check it is alive:

```bash
curl http://127.0.0.1:4100/healthz
```

## 4. Put a reverse proxy in front

WebSocket upgrade must pass through, or clients fall back to slower polling.

### Caddy

```caddyfile
sync.example.com {
    reverse_proxy 127.0.0.1:4100
}
```

Caddy handles TLS and WebSocket upgrades on its own.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

    # A first sync of a large vault arrives as one request.
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;

        # Without these two the sync event socket cannot be established.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The vault watch endpoint holds a request open for up to 50 seconds.
        proxy_read_timeout 120s;
    }
}
```

### Traefik

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.ravelon-sync.rule=Host(`sync.example.com`)
  - traefik.http.routers.ravelon-sync.tls.certresolver=letsencrypt
  - traefik.http.services.ravelon-sync.loadbalancer.server.port=4100
```

Then tell the server which address to trust:

```dotenv
TRUSTED_PROXY_IPS=127.0.0.1
```

Use the proxy's actual address. In Docker that is usually the gateway of the
bridge network, not `127.0.0.1`. Getting this wrong in the permissive
direction is worse than leaving it empty: an unlisted proxy just means rate
limits count the proxy instead of the client, while trusting everything lets
any client forge its own address.

```bash
docker compose restart sync
```

## 5. Create the administrator

Open `https://sync.example.com`. A deployment with no accounts shows first-run
setup: name the server, create your account.

That account is the administrator, and sign-up closes to `invite` behind it.

Do this promptly. Between the container starting and this form being
submitted, the first person to reach it becomes the administrator. If the
server will be reachable before you get to it, keep it bound to loopback and
use an SSH tunnel:

```bash
ssh -L 4100:127.0.0.1:4100 you@server
# then open http://127.0.0.1:4100
```

## 6. Invite your team

**Administration → Invitations → New invitation.**

With SMTP configured the link is emailed. Without it, the link is shown once
for you to copy. Both work; the second needs no mail server at all.

## 7. Connect a client

Ravelon desktop: **Settings → Account & sync → Own server**, enter your server
URL, sign in with your e-mail and password. The overview page shows the exact
URL.

There is nothing else to set up. The device derives the encryption key from
the account password; the server only ever receives the sealed envelope that
holds the account secret.

## Configuring email

**Administration → Settings → Email.** Send a test before relying on it; the
button verifies the connection and then actually delivers a message.

Environment variables work as a fallback if you would rather not click:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=sync@example.com
SMTP_PASSWORD=...
EMAIL_FROM=Ravelon Sync <sync@example.com>
```

Settings saved in the interface take precedence.

## PostgreSQL

SQLite is the default and handles a single instance and a small team without
complaint. Use PostgreSQL when you want replicas or a single backup story:

```bash
docker compose -f compose.postgres.yaml up -d
```

Migrations take an advisory lock at startup, so several replicas cannot race
through the same schema change.

## Upgrading

```bash
git pull
docker compose pull
docker compose up -d --build
```

Migrations run automatically. Take a backup first
([BACKUP.md](BACKUP.md)) — that advice is worth exactly as much as the last
time you ignored it.

## Running without Docker

```bash
npm install
npm run build
```

Then run `server/dist/main.js` under systemd:

```ini
[Unit]
Description=Ravelon Sync
After=network.target

[Service]
Type=simple
User=ravelon
WorkingDirectory=/opt/ravelon-sync
EnvironmentFile=/opt/ravelon-sync/.env
Environment=NODE_ENV=production
Environment=WEB_ROOT=/opt/ravelon-sync/server/public
ExecStart=/usr/bin/node server/dist/main.js
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/ravelon-sync/data

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

**"This official Ravelon Sync Server does not have an active license"** — the
client reached something that is not this server. Check the URL resolves to
your deployment and that `/v1/health` returns `officialBuild: false`.

**Client cannot connect at all** — Ravelon requires HTTPS outside
`127.0.0.1`. Check your certificate, and check `/v1/health` from the same
network the client is on.

**Sync works, but changes are slow to appear** — the WebSocket upgrade is not
reaching the server. See the proxy configuration above. Sync still works
through polling, just less promptly.

**Rate limits trip for everyone at once** — every request looks like it comes
from the proxy. Set `TRUSTED_PROXY_IPS` to the proxy's address.

**An administrator lost their second factor** — another administrator can
clear it from the user's row. If they were the only administrator, restore
from backup; there is deliberately no back door.

**Server will not start** — it prints the reason and exits. Missing secrets in
production are the usual cause.
