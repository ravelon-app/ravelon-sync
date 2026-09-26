#!/usr/bin/env bash
# Backs up a Ravelon Sync deployment.
#
#   ./scripts/backup.sh [/path/to/backups]
#
# Without a destination the backup goes to data/backups/ in this checkout,
# which git and the Docker build context both ignore. Prefer a path on another
# disk.
#
# Settings come from the environment first, then from the .env next to the
# compose files (the same precedence docker compose uses). The source is picked
# in this order, or forced with BACKUP_SOURCE:
#
#   host-postgres     DATABASE_URL is set: pg_dump on this host
#   host-sqlite       DATABASE_FILE exists on this host: an online SQLite backup
#   compose-postgres  POSTGRES_PASSWORD is set: pg_dump inside the postgres
#                     service of compose.postgres.yaml
#   compose-sqlite    otherwise: an online backup inside the sync service of
#                     compose.yaml, copied out of the container
#
# Every backup is written to a temporary name, checked, and only then renamed
# into place, so a file named ravelon-sync-*.gz is one that passed its checks.
#
# Copy the three secrets from .env into a safe place as well: a database
# without MFA_ENCRYPTION_KEY leaves every account unable to complete a second
# factor.
#
# The backup contains ciphertext this server cannot read. That is a feature,
# and it also means a backup alone will never restore anyone's vault contents
# without the account's own sync passphrase, which lives only on their devices.

set -euo pipefail
# Backups hold password hashes and encrypted TOTP secrets. Nobody else on the
# host needs to read them.
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${RAVELON_ENV_FILE:-$ROOT/.env}"

fail() {
  echo "backup: $*" >&2
  exit 1
}

# Reads KEY from .env without executing it. Sourcing the file is not safe:
# EMAIL_FROM=Ravelon Sync <sync@example.com> is valid for docker compose and a
# syntax error (or worse, a command) for the shell.
dotenv_value() {
  local key="$1" line value
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    *)
      # Unquoted: a " #" starts a comment, as in docker compose.
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# The environment wins over .env.
setting() {
  local key="$1"
  if [ -n "${!key+set}" ]; then
    printf '%s' "${!key}"
  else
    dotenv_value "$key"
  fi
}

DESTINATION="${1:-$ROOT/data/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DESTINATION"

DATABASE_URL="$(setting DATABASE_URL)"
DATABASE_FILE="$(setting DATABASE_FILE)"
DATABASE_FILE="${DATABASE_FILE:-./data/ravelon-sync.db}"
# A relative path in .env is relative to the deployment, not to wherever cron
# happens to start this script.
case "$DATABASE_FILE" in
  /*) ;;
  *) DATABASE_FILE="$ROOT/${DATABASE_FILE#./}" ;;
esac
POSTGRES_PASSWORD="$(setting POSTGRES_PASSWORD)"

SOURCE="${BACKUP_SOURCE:-auto}"
if [ "$SOURCE" = auto ]; then
  if [ -n "$DATABASE_URL" ]; then
    SOURCE=host-postgres
  elif [ -f "$DATABASE_FILE" ]; then
    SOURCE=host-sqlite
  elif [ -n "$POSTGRES_PASSWORD" ]; then
    SOURCE=compose-postgres
  else
    SOURCE=compose-sqlite
  fi
fi

PARTIAL=""
CONTAINER_TMP=""
cleanup() {
  [ -z "$PARTIAL" ] || rm -f "$PARTIAL" "$PARTIAL.gz" "$PARTIAL-wal" "$PARTIAL-shm"
  if [ -n "$CONTAINER_TMP" ]; then
    compose exec -T sync rm -f "$CONTAINER_TMP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

compose() {
  docker compose --project-directory "$ROOT" -f "$COMPOSE_FILE" "$@"
}

require_nonempty() {
  [ -s "$1" ] || fail "the backup at $1 is empty"
}

# Takes a finished SQLite copy out of WAL mode, so the one file is the whole
# database, and runs PRAGMA integrity_check on it with whatever is here.
check_sqlite_copy() {
  local file="$1" result
  if command -v sqlite3 >/dev/null 2>&1; then
    result="$(sqlite3 "$file" 'PRAGMA journal_mode = DELETE;' 'PRAGMA integrity_check;' | tail -n 1)"
  elif command -v node >/dev/null 2>&1 && [ -d "$ROOT/node_modules/better-sqlite3" ]; then
    result="$(node -e '
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2], { fileMustExist: true });
      db.pragma("journal_mode = DELETE");
      console.log(db.pragma("integrity_check", { simple: true }));
      db.close();
    ' "$ROOT/node_modules/better-sqlite3" "$file")"
  else
    echo "backup: neither sqlite3 nor better-sqlite3 is available here; integrity not checked on this host" >&2
    return 0
  fi
  [ "$result" = ok ] || fail "integrity check failed for $file: $result"
  rm -f "$file-wal" "$file-shm"
}

finish() {
  local partial="$1" final="$2"
  require_nonempty "$partial"
  gzip -t "$partial" || fail "the compressed backup $partial is damaged"
  mv "$partial" "$final"
  PARTIAL=""
  echo "Wrote $final"
}

case "$SOURCE" in
  host-postgres)
    [ -n "$DATABASE_URL" ] || fail "BACKUP_SOURCE=host-postgres needs DATABASE_URL"
    command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is required for a PostgreSQL deployment"
    OUT="$DESTINATION/ravelon-sync-$STAMP.sql.gz"
    PARTIAL="$OUT.partial"
    pg_dump --no-owner --no-privileges --dbname="$DATABASE_URL" | gzip > "$PARTIAL"
    # pg_dump writes this line last. Without it the dump was cut short.
    gzip -dc "$PARTIAL" | tail -n 5 | grep -q 'PostgreSQL database dump complete' \
      || fail "the dump in $PARTIAL is incomplete"
    finish "$PARTIAL" "$OUT"
    ;;

  compose-postgres)
    command -v docker >/dev/null 2>&1 || fail "docker is required for a compose deployment"
    COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$ROOT/compose.postgres.yaml}"
    OUT="$DESTINATION/ravelon-sync-$STAMP.sql.gz"
    PARTIAL="$OUT.partial"
    # Runs as the database owner over the container's local socket, so no
    # password has to be passed around or quoted.
    compose exec -T postgres sh -c \
      'exec pg_dump --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      | gzip > "$PARTIAL"
    gzip -dc "$PARTIAL" | tail -n 5 | grep -q 'PostgreSQL database dump complete' \
      || fail "the dump in $PARTIAL is incomplete"
    finish "$PARTIAL" "$OUT"
    ;;

  host-sqlite)
    [ -f "$DATABASE_FILE" ] || fail "no database at $DATABASE_FILE. Set DATABASE_FILE or DATABASE_URL."
    OUT="$DESTINATION/ravelon-sync-$STAMP.db"
    PARTIAL="$OUT"
    # Never a plain cp: the database runs in WAL mode, and committed data can
    # sit in the -wal file where a copy of the main file misses it.
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$DATABASE_FILE" ".timeout 10000" ".backup '$OUT'"
    elif command -v node >/dev/null 2>&1 && [ -d "$ROOT/node_modules/better-sqlite3" ]; then
      node -e '
        const Database = require(process.argv[1]);
        const db = new Database(process.argv[2], { fileMustExist: true });
        db.backup(process.argv[3])
          .then(() => db.close())
          .catch((error) => { console.error(error.message); process.exit(1); });
      ' "$ROOT/node_modules/better-sqlite3" "$DATABASE_FILE" "$OUT"
    else
      fail "an online SQLite backup needs sqlite3 or this checkout's node_modules. Install sqlite3; copying the live file is not a backup."
    fi
    require_nonempty "$OUT"
    check_sqlite_copy "$OUT"
    gzip -f "$OUT"
    PARTIAL="$OUT.gz.partial"
    mv "$OUT.gz" "$PARTIAL"
    finish "$PARTIAL" "$OUT.gz"
    ;;

  compose-sqlite)
    command -v docker >/dev/null 2>&1 \
      || fail "no database at $DATABASE_FILE and docker is not available. Set DATABASE_FILE or DATABASE_URL."
    COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$ROOT/compose.yaml}"
    CONTAINER_DB="${BACKUP_CONTAINER_DB:-/data/ravelon-sync.db}"
    CONTAINER_TMP="/data/.backup-$STAMP.db"
    OUT="$DESTINATION/ravelon-sync-$STAMP.db"
    PARTIAL="$OUT"
    # The image has no sqlite3 binary, but it has better-sqlite3, whose
    # backup() is the same online backup API.
    compose exec -T sync node -e '
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { fileMustExist: true });
      db.backup(process.argv[2])
        .then(() => {
          db.close();
          const copy = new Database(process.argv[2], { fileMustExist: true });
          copy.pragma("journal_mode = DELETE");
          const result = copy.pragma("integrity_check", { simple: true });
          copy.close();
          if (result !== "ok") throw new Error("integrity check failed: " + result);
        })
        .catch((error) => { console.error(error.message); process.exit(1); });
    ' "$CONTAINER_DB" "$CONTAINER_TMP"
    compose cp "sync:$CONTAINER_TMP" "$OUT"
    # docker cp keeps the container's file mode, which ignores the umask above.
    chmod 600 "$OUT"
    compose exec -T sync rm -f "$CONTAINER_TMP"
    CONTAINER_TMP=""
    require_nonempty "$OUT"
    check_sqlite_copy "$OUT"
    gzip -f "$OUT"
    PARTIAL="$OUT.gz.partial"
    mv "$OUT.gz" "$PARTIAL"
    finish "$PARTIAL" "$OUT.gz"
    ;;

  *)
    fail "unknown BACKUP_SOURCE '$SOURCE' (host-postgres, host-sqlite, compose-postgres, compose-sqlite)"
    ;;
esac

echo "Remember to back up SYNC_JWT_SECRET, MFA_ENCRYPTION_KEY and SETTINGS_ENCRYPTION_KEY."
