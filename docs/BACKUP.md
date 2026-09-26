# Backup and restore

## What to back up

Two things, together:

1. **The database** — accounts, teams, memberships, and every encrypted record
2. **The three secrets** from `.env`

A database without `MFA_ENCRYPTION_KEY` leaves everyone with two-factor unable
to complete a sign-in. Restoring one without the other is not a restore.

What you do *not* have, and cannot back up, is anyone's account secret in the
clear. It reaches the server only sealed under a key derived from the account
password on the device. Backups contain ciphertext; they are not a way to
recover somebody's vault contents, and that is the point.

## The backup script

```bash
./scripts/backup.sh /var/backups/ravelon-sync
```

It reads `.env` from the checkout (without executing it; variables already
set in the environment win) and picks the source on its own:

| Your deployment | What it runs |
| --- | --- |
| `DATABASE_URL` set | `pg_dump` on this host |
| `DATABASE_FILE` exists on this host | an online SQLite backup on this host |
| `POSTGRES_PASSWORD` set (`compose.postgres.yaml`) | `pg_dump` inside the `postgres` container |
| anything else (`compose.yaml`) | an online SQLite backup inside the `sync` container, copied out |

Set `BACKUP_SOURCE` to `host-postgres`, `host-sqlite`, `compose-postgres` or
`compose-sqlite` to choose yourself, and `BACKUP_COMPOSE_FILE` if your compose
file lives elsewhere. For `host-postgres`, the local `pg_dump` must be the same
major version as the server or newer.

Every backup is checked before it gets its final name: it must not be empty,
the archive must decompress, a PostgreSQL dump must end with pg_dump's
completion marker, and a SQLite copy must pass `PRAGMA integrity_check`. Any
failure exits non-zero and leaves no `ravelon-sync-*.gz` behind, so cron mails
you instead of quietly keeping an empty file. Backups are created readable by
their owner only.

## SQLite

The database runs in WAL mode, so copying the file while the server runs can
miss committed data sitting in the write-ahead log. The script never does
that: it uses SQLite's online backup, which is safe against a live server, and
refuses to run when neither `sqlite3` nor this checkout's `node_modules` is
there to provide it.

By hand, on the host:

```bash
sqlite3 ./data/ravelon-sync.db ".backup '/var/backups/ravelon-sync-$(date -u +%F).db'"
```

From a container (the image has no `sqlite3`, but it has the same backup API):

```bash
docker compose exec -T sync \
  node -e "require('better-sqlite3')('/data/ravelon-sync.db').backup('/data/backup.db').then(() => console.log('ok'))"
docker compose cp sync:/data/backup.db ./ravelon-sync-backup.db
docker compose exec -T sync rm /data/backup.db
```

## PostgreSQL

```bash
docker compose -f compose.postgres.yaml exec -T postgres \
  sh -c 'pg_dump --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > ravelon-sync-$(date -u +%F).sql.gz
```

Run it with `set -o pipefail` (bash) if you script it yourself. Without it,
a failed `pg_dump` still leaves `gzip` succeeding, and the pipeline reports
success for an empty backup.

## Automating it

```cron
0 3 * * * cd /opt/ravelon-sync && ./scripts/backup.sh /var/backups/ravelon-sync >> /var/log/ravelon-sync-backup.log 2>&1
0 4 * * 0 find /var/backups/ravelon-sync -name 'ravelon-sync-*.gz' -mtime +30 -delete
```

The script needs to be executable (`chmod +x scripts/backup.sh`) and the cron
user needs access to Docker for a compose deployment. Look at the log now and
then: a backup job that has been failing since spring is a common way to find
out you have no backups.

Back the secrets up separately, somewhere your database backups are not. A
single compromised location holding both is a worse position than either alone.

## Restoring

Stop the server first. Restoring underneath a running process corrupts it.
Use `stop`, not `down`: `down` removes the container, and the steps below need
it (or its volume) to still exist.

### SQLite in Docker

```bash
docker compose stop sync
docker compose run --rm --no-deps -T --user root --entrypoint sh \
  -v "$PWD/ravelon-sync-20260827T030000Z.db.gz:/restore/backup.db.gz:ro" \
  sync -c '
    set -e
    rm -f /data/ravelon-sync.db-wal /data/ravelon-sync.db-shm
    gzip -dc /restore/backup.db.gz > /data/ravelon-sync.db
    chown node:node /data/ravelon-sync.db
  '
docker compose start sync
```

The one-off container mounts the same volume while the server is stopped.
Removing the old `-wal` and `-shm` files is not optional: SQLite would replay
the old write-ahead log onto the restored file and corrupt it. The `chown`
matters because the server runs as `node` (uid 1000), not root.

For an uncompressed `.db` (the manual `docker compose cp` backup above), mount
it at `/restore/backup.db` and use `cp /restore/backup.db /data/ravelon-sync.db`
instead of the `gzip` line.

### SQLite without Docker

```bash
sudo systemctl stop ravelon-sync
rm -f data/ravelon-sync.db-wal data/ravelon-sync.db-shm
gunzip -c ravelon-sync-20260827T030000Z.db.gz > data/ravelon-sync.db
sudo systemctl start ravelon-sync
```

### PostgreSQL

Restore into an empty database. Piping a dump into one that still holds data
fails on the first existing table, or worse, half-applies on top of it.

```bash
docker compose -f compose.postgres.yaml stop sync
docker compose -f compose.postgres.yaml exec -T postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
gunzip -c ravelon-sync-20260827T030000Z.sql.gz | \
  docker compose -f compose.postgres.yaml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction'
docker compose -f compose.postgres.yaml start sync
```

`ON_ERROR_STOP` with `--single-transaction` means a restore either applies
completely or not at all. For a PostgreSQL server of your own, do the same
with `dropdb`, `createdb` and `psql` against it while the sync server is
stopped.

Restore the same secrets alongside it. Migrations run automatically on start,
so a backup from an older version upgrades itself.

## Verifying a backup

An untested backup is a hope, not a plan.

```bash
gunzip -k ravelon-sync-20260827T030000Z.db.gz
mv ravelon-sync-20260827T030000Z.db ravelon-sync-backup.db
sqlite3 ./ravelon-sync-backup.db "SELECT COUNT(*) FROM users;"
sqlite3 ./ravelon-sync-backup.db "SELECT COUNT(*) FROM sync_items;"
sqlite3 ./ravelon-sync-backup.db "PRAGMA integrity_check;"
```

Better: restore it into a throwaway deployment with the same secrets and sign
in, including a second factor. That is the only check that proves the secrets
match the database.

## What a restore cannot fix

- **A forgotten account password with no signed-in device left.** A reset gets
  the person back into the account, not into the vault; nothing recovers the
  contents without a device that still holds the secret.
- **A lost `MFA_ENCRYPTION_KEY`.** Every account must enrol again. With at
  least one administrator able to sign in, they can clear the others.
- **Records deleted before the backup.** Version history is bounded by the
  per-record limit in settings.
