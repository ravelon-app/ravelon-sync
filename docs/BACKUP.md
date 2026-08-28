# Backup and restore

## What to back up

Two things, together:

1. **The database** — accounts, teams, memberships, and every encrypted record
2. **The three secrets** from `.env`

A database without `MFA_ENCRYPTION_KEY` leaves everyone with two-factor unable
to complete a sign-in. Restoring one without the other is not a restore.

What you do *not* have, and cannot back up, is anyone's sync passphrase. It
never reaches the server. Backups contain ciphertext; they are not a way to
recover somebody's vault contents, and that is the point.

## SQLite

The database runs in WAL mode, so copying the file while the server runs can
miss committed data sitting in the write-ahead log. Use `.backup`, which is
safe against a live server:

```bash
./scripts/backup.sh /var/backups/ravelon-sync
```

Or by hand:

```bash
sqlite3 /data/ravelon-sync.db ".backup '/var/backups/ravelon-sync-$(date -u +%F).db'"
```

From a container:

```bash
docker compose exec -T sync \
  node -e "require('better-sqlite3')('/data/ravelon-sync.db').backup('/data/backup.db')"
docker compose cp sync:/data/backup.db ./ravelon-sync-backup.db
```

## PostgreSQL

```bash
docker compose -f compose.postgres.yaml exec -T postgres \
  pg_dump -U ravelon ravelon_sync | gzip > ravelon-sync-$(date -u +%F).sql.gz
```

## Automating it

```cron
0 3 * * * cd /opt/ravelon-sync && ./scripts/backup.sh /var/backups/ravelon-sync
0 4 * * 0 find /var/backups/ravelon-sync -name '*.gz' -mtime +30 -delete
```

Back the secrets up separately, somewhere your database backups are not. A
single compromised location holding both is a worse position than either alone.

## Restoring

Stop the server first. Restoring underneath a running process corrupts it.

```bash
docker compose down
docker compose cp ./ravelon-sync-backup.db sync:/data/ravelon-sync.db
docker compose up -d
```

PostgreSQL:

```bash
gunzip -c ravelon-sync-2026-08-27.sql.gz | \
  docker compose -f compose.postgres.yaml exec -T postgres psql -U ravelon ravelon_sync
```

Restore the same secrets alongside it. Migrations run automatically on start,
so a backup from an older version upgrades itself.

## Verifying a backup

An untested backup is a hope, not a plan.

```bash
sqlite3 ./ravelon-sync-backup.db "SELECT COUNT(*) FROM users;"
sqlite3 ./ravelon-sync-backup.db "SELECT COUNT(*) FROM sync_items;"
sqlite3 ./ravelon-sync-backup.db "PRAGMA integrity_check;"
```

Better: restore it into a throwaway deployment with the same secrets and sign
in, including a second factor. That is the only check that proves the secrets
match the database.

## What a restore cannot fix

- **A lost sync passphrase.** Nothing recovers vault contents without it.
- **A lost `MFA_ENCRYPTION_KEY`.** Every account must enrol again. With at
  least one administrator able to sign in, they can clear the others.
- **Records deleted before the backup.** Version history is bounded by the
  per-record limit in settings.
