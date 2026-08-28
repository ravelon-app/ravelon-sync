#!/usr/bin/env sh
# Backs up a Ravelon Sync deployment.
#
#   ./scripts/backup.sh /path/to/backups
#
# For SQLite this uses `.backup`, which takes a consistent copy while the
# server is running. For PostgreSQL it runs pg_dump. Either way, copy your
# three secrets from .env into the same safe place: a database without
# MFA_ENCRYPTION_KEY leaves every account unable to complete a second factor.
#
# The backup contains ciphertext this server cannot read. That is a feature,
# and it also means a backup alone will never restore anyone's vault contents
# without the account's own sync passphrase, which lives only on their devices.

set -eu

DESTINATION="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DESTINATION"

if [ -n "${DATABASE_URL:-}" ]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "pg_dump is required for a PostgreSQL deployment" >&2
    exit 1
  fi
  OUT="$DESTINATION/ravelon-sync-$STAMP.sql.gz"
  pg_dump "$DATABASE_URL" | gzip > "$OUT"
  echo "Wrote $OUT"
  exit 0
fi

DB="${DATABASE_FILE:-./data/ravelon-sync.db}"
if [ ! -f "$DB" ]; then
  echo "No database at $DB. Set DATABASE_FILE or DATABASE_URL." >&2
  exit 1
fi

OUT="$DESTINATION/ravelon-sync-$STAMP.db"
if command -v sqlite3 >/dev/null 2>&1; then
  # `.backup` is safe against a running server; copying the file is not,
  # because the write-ahead log may hold committed data the file does not.
  sqlite3 "$DB" ".backup '$OUT'"
else
  echo "sqlite3 not found; stop the server before trusting this copy" >&2
  cp "$DB" "$OUT"
fi

gzip -f "$OUT"
echo "Wrote $OUT.gz"
echo "Remember to back up SYNC_JWT_SECRET, MFA_ENCRYPTION_KEY and SETTINGS_ENCRYPTION_KEY."
