#!/usr/bin/env sh
# Prints the three secrets Ravelon Sync requires, ready to paste into .env.
#
#   ./scripts/generate-secrets.sh
#
# Back these up with your database. Losing MFA_ENCRYPTION_KEY means every
# account has to enrol its authenticator again; losing SETTINGS_ENCRYPTION_KEY
# means re-entering the SMTP password.

set -eu

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

printf 'SYNC_JWT_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
printf 'MFA_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
