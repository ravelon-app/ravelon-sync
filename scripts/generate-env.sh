#!/usr/bin/env bash
set -euo pipefail

OUTPUT=${ENV_OUTPUT:-.env}
FORCE=false
ASSUME_DEFAULTS=false
APP_NAME="Ravelon Sync"

for arg in "$@"; do
  case "$arg" in
    -f | --force) FORCE=true ;;
    -y | --yes) ASSUME_DEFAULTS=true ;;
    -h | --help)
      printf 'Usage: %s [--force] [--yes]\n\n' "$0"
      printf '  --force  regenerate an existing %s and keep its values\n' "$OUTPUT"
      printf '  --yes    accept every default without asking\n\n'
      printf 'Variables already set in the environment are used as answers.\n'
      printf 'DATABASE=sqlite, postgres or external picks the database.\n'
      printf 'ENV_OUTPUT=path writes somewhere other than %s.\n' "$OUTPUT"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 64
      ;;
  esac
done

if ((BASH_VERSINFO[0] < 5)); then
  printf 'bash 5 or newer is required (found %s). On macOS: brew install bash\n' "$BASH_VERSION" >&2
  exit 1
fi

if [[ -f $OUTPUT && $FORCE != true ]]; then
  printf '%s already exists. Run with --force to regenerate it and keep its values.\n' "$OUTPUT" >&2
  exit 1
fi

INTERACTIVE=false
if [[ -t 0 && $ASSUME_DEFAULTS != true ]]; then
  INTERACTIVE=true
fi

if [[ -t 2 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' CYAN=$'\e[36m' RESET=$'\e[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
fi
P_BOLD=$'\001'$BOLD$'\002' P_DIM=$'\001'$DIM$'\002' P_CYAN=$'\001'$CYAN$'\002' P_RESET=$'\001'$RESET$'\002'

declare -A VALUES=()
declare -A HIDDEN=()
declare -A DROPPED=()
ORDER=()
REQUIRED_MISSING=()
CHOICE=""

SAFE_RE='^[A-Za-z0-9_./:@?=&%+,~-]*$'
ORIGIN_RE='^https?://[^[:space:]/,]+$'
ORIGINS_RE='^(https?://[^[:space:]/,]+(,https?://[^[:space:]/,]+)*)?$'
EXAMPLE_RE='(^|[@/.])example\.(com|net|org)([:/>]|$)'
IP_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
IPS_RE='^([0-9A-Fa-f:.]+(/[0-9]{1,3})?(,[0-9A-Fa-f:.]+(/[0-9]{1,3})?)*)?$'
HOST_RE='^[A-Za-z0-9.-]+$'
SENDER_RE='^([^<>]*<[^[:space:]@<>]+@[^[:space:]@<>]+>|[^[:space:]@<>]+@[^[:space:]@<>]+)$'
POSTGRES_RE='^postgres(ql)?://[^[:space:]]+$'

say() { printf '%s\n' "$*" >&2; }
fail() {
  say "${RED}✖${RESET} $*"
  exit 1
}

existing() {
  [[ -f $OUTPUT ]] || return 0
  local line
  line=$(grep -E "^$1=" "$OUTPUT" | tail -n 1) || return 0
  line=${line#*=}
  if [[ $line == \"*\" && ${#line} -ge 2 ]]; then
    line=${line:1:${#line}-2}
    line=${line//\\\"/\"}
    line=${line//\\\\/\\}
  elif [[ $line == \'*\' && ${#line} -ge 2 ]]; then
    line=${line:1:${#line}-2}
  fi
  printf '%s' "$line"
}

current() {
  local key=$1
  if [[ -n ${!key-} ]]; then
    printf '%s' "${!key}"
  else
    existing "$key"
  fi
}

remember() {
  [[ -v VALUES[$1] ]] || ORDER+=("$1")
  VALUES[$1]=$2
}

value_of() { printf '%s' "${VALUES[$1]-}"; }
hide() { HIDDEN[$1]=1; }
is_hidden() { [[ -v HIDDEN[$1] ]]; }
drop() { DROPPED[$1]=1; }
set_value() { remember "$1" "$2"; }

keep_or() {
  local key=$1 value
  value=$(current "$key")
  remember "$key" "${value:-$2}"
}

section() {
  ORDER+=("@$1")
  if $INTERACTIVE; then
    say ""
    say "${BOLD}$1${RESET}"
  fi
}

validate() {
  local rule=$1 value=$2
  case "$rule" in
    '' | optional) return 0 ;;
    required) [[ -n $value ]] || { printf 'a value is required'; return 1; } ;;
    origin) [[ $value =~ $ORIGIN_RE ]] || { printf 'enter an origin like https://sync.yourdomain.com (no path, no trailing slash)'; return 1; } ;;
    origins) [[ $value =~ $ORIGINS_RE ]] || { printf 'enter origins separated by commas, like https://app.yourdomain.com'; return 1; } ;;
    real) [[ ! $value =~ $EXAMPLE_RE ]] || { printf 'replace the example address with your own'; return 1; } ;;
    ip) [[ $value =~ $IP_RE ]] || { printf 'enter an IPv4 address like 127.0.0.1'; return 1; } ;;
    ips) [[ $value =~ $IPS_RE ]] || { printf 'enter addresses or CIDRs separated by commas, like 172.18.0.1'; return 1; } ;;
    host) [[ $value =~ $HOST_RE ]] || { printf 'enter a host name'; return 1; } ;;
    port) { [[ $value =~ ^[0-9]+$ ]] && ((10#$value >= 1 && 10#$value <= 65535)); } || { printf 'enter a port between 1 and 65535'; return 1; } ;;
    int) { [[ $value =~ ^[0-9]+$ ]] && ((10#$value >= 1)); } || { printf 'enter a whole number above 0'; return 1; } ;;
    sender) [[ $value =~ $SENDER_RE ]] || { printf 'enter an address like Ravelon Sync <sync@yourdomain.com>'; return 1; } ;;
    postgres) [[ $value =~ $POSTGRES_RE ]] || { printf 'enter a URL like postgresql://ravelon:password@db.internal:5432/ravelon_sync'; return 1; } ;;
    *) printf 'unknown rule %s' "$rule"; return 1 ;;
  esac
}

check_all() {
  local value=$1 rule message
  shift
  if [[ $value == *\'* || $value == *$'\n'* ]]; then
    printf 'single quotes and line breaks are not supported'
    return 1
  fi
  for rule in "$@"; do
    if ! message=$(validate "$rule" "$value"); then
      printf '%s' "$message"
      return 1
    fi
  done
}

ask() {
  local key=$1 label=$2 fallback=${3-} value input message
  shift 3 || shift $#
  local rules=("$@")
  value=$(current "$key")
  value=${value:-$fallback}
  if ! $INTERACTIVE; then
    if message=$(check_all "$value" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$value"
      return
    fi
    [[ -z $value ]] && REQUIRED_MISSING+=("$key")
    [[ -n $value ]] && fail "$key: $message"
    remember "$key" "$value"
    return
  fi
  while true; do
    read -r -e -i "$value" -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} " input || exit 130
    if message=$(check_all "$input" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$input"
      return
    fi
    say "  ${RED}${message}${RESET}"
  done
}

ask_secret() {
  local key=$1 label=$2 value input message hint
  shift 2
  local rules=("$@")
  value=$(current "$key")
  hide "$key"
  if ! $INTERACTIVE; then
    if message=$(check_all "$value" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$value"
      return
    fi
    [[ -z $value ]] && REQUIRED_MISSING+=("$key")
    [[ -n $value ]] && fail "$key: $message"
    remember "$key" "$value"
    return
  fi
  hint="leave empty to skip"
  [[ -n $value ]] && hint="leave empty to keep the current value"
  while true; do
    read -r -s -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} ${P_DIM}(${hint})${P_RESET} " input || exit 130
    printf '\n' >&2
    input=${input:-$value}
    if message=$(check_all "$input" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$input"
      return
    fi
    say "  ${RED}${message}${RESET}"
  done
}

select_from() {
  local label=$1 value=$2 input index name note option
  shift 2
  local names=() notes=()
  for option in "$@"; do
    names+=("${option%%|*}")
    if [[ $option == *\|* ]]; then notes+=("${option#*|}"); else notes+=(""); fi
  done
  if ! $INTERACTIVE; then
    for name in "${names[@]}"; do
      if [[ $name == "$value" ]]; then
        CHOICE=$value
        return
      fi
    done
    fail "$label must be one of: ${names[*]}"
  fi
  say "${CYAN}?${RESET} ${BOLD}${label}${RESET}"
  for index in "${!names[@]}"; do
    note=""
    [[ -z ${notes[$index]} ]] || note=" ${DIM}${notes[$index]}${RESET}"
    if [[ ${names[$index]} == "$value" ]]; then
      say "  ${GREEN}$((index + 1))) ${names[$index]}${RESET}${note}"
    else
      say "  $((index + 1))) ${names[$index]}${note}"
    fi
  done
  while true; do
    read -r -e -p "  ${P_DIM}number or name, Enter keeps ${value}${P_RESET} " input || exit 130
    input=${input:-$value}
    if [[ $input =~ ^[0-9]+$ ]] && ((10#$input >= 1 && 10#$input <= ${#names[@]})); then
      input=${names[$((10#$input - 1))]}
    fi
    for name in "${names[@]}"; do
      if [[ $name == "$input" ]]; then
        CHOICE=$input
        return
      fi
    done
    say "  ${RED}choose one of: ${names[*]}${RESET}"
  done
}

choose() {
  local key=$1 label=$2 fallback=$3 value
  shift 3
  value=$(current "$key")
  select_from "$label" "${value:-$fallback}" "$@"
  remember "$key" "$CHOICE"
}

confirm() {
  local label=$1 fallback=${2:-y} input
  if ! $INTERACTIVE; then
    [[ $fallback == y ]]
    return
  fi
  local shown="Y/n"
  [[ $fallback == n ]] && shown="y/N"
  while true; do
    read -r -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} ${P_DIM}(${shown})${P_RESET} " input || exit 130
    input=${input:-$fallback}
    case "${input,,}" in
      y | yes | j | ja) return 0 ;;
      n | no | nein) return 1 ;;
    esac
  done
}

gen_secret() { head -c 48 /dev/urandom | base64 | tr -d '\n'; }
gen_password() { head -c 24 /dev/urandom | base64 | tr -d '\n' | tr '+/' '-_'; }
is_placeholder() { (($(fold -w1 <<<"$1" | sort -u | wc -l) < 8)); }

generated() {
  local key=$1 inherit=${2-} value previous
  value=$(current "$key")
  previous=$(existing SYNC_JWT_SECRET)
  hide "$key"
  if [[ -z $value && -n $inherit && -n $previous && $previous == "$(value_of SYNC_JWT_SECRET)" ]]; then
    value=$(value_of "$inherit")
    say "${YELLOW}!${RESET} $key was unset, so the server used $inherit. Kept that value so stored data stays readable."
  fi
  if ((${#value} < 32)) || is_placeholder "$value"; then
    [[ -z $value ]] || say "${YELLOW}!${RESET} Replaced $key (too short or a placeholder)."
    value=$(gen_secret)
  fi
  remember "$key" "$value"
}

quote() {
  local value=$1
  if [[ $value =~ $SAFE_RE ]]; then
    printf '%s' "$value"
  elif [[ $value == *\'* || $value == *$'\n'* ]]; then
    fail "values must not contain single quotes or line breaks"
  else
    printf "'%s'" "$value"
  fi
}

mask() {
  local value=$1
  if [[ -z $value ]]; then
    printf '%s' "${DIM}(empty)${RESET}"
  else
    printf '%s' "${DIM}••••••${value: -4}${RESET}"
  fi
}

summary() {
  local entry shown
  say ""
  say "${BOLD}Summary${RESET}"
  for entry in "${ORDER[@]}"; do
    [[ $entry == @* ]] && continue
    if is_hidden "$entry"; then
      say "  ${entry} = $(mask "$(value_of "$entry")")"
    else
      shown=$(value_of "$entry")
      say "  ${entry} = ${shown:-${DIM}(empty)${RESET}}"
    fi
  done
}

unmanaged_lines() {
  [[ -f $OUTPUT ]] || return 0
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    [[ -v VALUES[${BASH_REMATCH[1]}] || -v DROPPED[${BASH_REMATCH[1]}] ]] && continue
    printf '%s\n' "$line"
  done <"$OUTPUT"
}

write_env() {
  local tmp entry key started=false gap=false backup="" unmanaged removed=()
  unmanaged=$(unmanaged_lines)
  for key in "${!DROPPED[@]}"; do
    [[ -z $(existing "$key") ]] || removed+=("$key")
  done
  tmp=$(mktemp "${OUTPUT}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  {
    for entry in "${ORDER[@]}"; do
      if [[ $entry == @* ]]; then
        gap=$started
        continue
      fi
      if $gap; then
        printf '\n'
      fi
      gap=false
      started=true
      printf '%s=%s\n' "$entry" "$(quote "$(value_of "$entry")")"
    done
    if [[ -n $unmanaged ]]; then
      printf '\n%s\n' "$unmanaged"
    fi
  } >"$tmp"
  if [[ -n $unmanaged ]]; then
    say "${DIM}Kept $(wc -l <<<"$unmanaged" | tr -d ' ') variable(s) this script does not manage.${RESET}"
  fi
  if ((${#removed[@]})); then
    say "${DIM}Removed ${removed[*]}.${RESET}"
  fi
  chmod 600 "$tmp"
  if [[ -f $OUTPUT ]]; then
    cp -p "$OUTPUT" "$OUTPUT.bak"
    chmod 600 "$OUTPUT.bak"
    backup=" (previous version in $OUTPUT.bak)"
  fi
  mv "$tmp" "$OUTPUT"
  trap - EXIT
  say "${GREEN}✔${RESET} Wrote ${BOLD}$OUTPUT${RESET}$backup"
}

if $INTERACTIVE; then
  say "${BOLD}${APP_NAME}${RESET} production environment"
  say "${DIM}Enter accepts the value shown. Secrets are generated automatically.${RESET}"
fi

section "Server"
ask PUBLIC_URL "Public URL people reach the server at" "" required origin real
ask BIND_IP "Bind address (127.0.0.1 for a proxy on this host, 0.0.0.0 for all)" 127.0.0.1 required ip
ask PORT "Port on this host" 4100 required port
ask TRUSTED_PROXY_IPS "Reverse proxy IPs, comma separated (empty if none)" "" ips

section "Secrets"
if $INTERACTIVE; then
  say "${DIM}Generated, existing ones are kept.${RESET}"
fi
generated SYNC_JWT_SECRET
generated MFA_ENCRYPTION_KEY SYNC_JWT_SECRET
generated SETTINGS_ENCRYPTION_KEY MFA_ENCRYPTION_KEY

section "Database"
if [[ -n $(current POSTGRES_PASSWORD) ]]; then
  detected=postgres
elif [[ -n $(current DATABASE_URL) ]]; then
  detected=external
else
  detected=sqlite
fi
select_from "Database" "${DATABASE:-$detected}" \
  "sqlite|SQLite file, simplest for one server" \
  "postgres|bundled PostgreSQL container" \
  "external|a PostgreSQL server you already run"
database=$CHOICE
if [[ -f $OUTPUT && $database != "$detected" ]]; then
  say "${YELLOW}!${RESET} Switching the database does not move existing data."
fi
case "$database" in
  postgres)
    keep_or POSTGRES_USER ravelon
    keep_or POSTGRES_DB ravelon_sync
    keep_or POSTGRES_PASSWORD "$(gen_password)"
    hide POSTGRES_PASSWORD
    drop DATABASE_URL
    ;;
  *)
    drop POSTGRES_USER
    drop POSTGRES_DB
    drop POSTGRES_PASSWORD
    if [[ $database == external ]]; then
      ask_secret DATABASE_URL "PostgreSQL URL, special characters in the password percent-encoded" required postgres
    else
      drop DATABASE_URL
    fi
    ;;
esac

section "Email"
smtp_default=n
[[ -z $(current SMTP_HOST) ]] || smtp_default=y
if confirm "Send invitations and password resets by email (SMTP)?" "$smtp_default"; then
  ask SMTP_HOST "SMTP host" "" required host
  choose SMTP_SECURITY "SMTP security" starttls "starttls|usually port 587" "tls|usually port 465" "none|unencrypted"
  case "$(value_of SMTP_SECURITY)" in
    tls) smtp_port=465 ;;
    none) smtp_port=25 ;;
    *) smtp_port=587 ;;
  esac
  case "$(current SMTP_PORT)" in
    '' | 25 | 465 | 587) export SMTP_PORT=$smtp_port ;;
  esac
  ask SMTP_PORT "SMTP port" "$smtp_port" required port
  ask SMTP_USER "SMTP user (empty if none)" "" optional
  ask_secret SMTP_PASSWORD "SMTP password" optional
  mail_domain=$(value_of PUBLIC_URL)
  mail_domain=${mail_domain#*://}
  mail_domain=${mail_domain%%[:/]*}
  ask EMAIL_FROM "Sender" "Ravelon Sync <sync@$mail_domain>" required sender real
else
  set_value SMTP_HOST ""
  if $INTERACTIVE; then
    say "${DIM}Invitation and reset links are shown in the admin interface instead.${RESET}"
  fi
fi

section "Limits"
limits_default=n
for key in CORS_ORIGINS VAULT_STORAGE_LIMIT_MB VAULTS_PER_USER ACCESS_TOKEN_TTL_SEC REFRESH_TOKEN_TTL_DAYS; do
  [[ -z ${!key-} ]] || limits_default=y
done
if confirm "Change limits or allow extra browser origins?" "$limits_default"; then
  ask CORS_ORIGINS "Extra browser origins, comma separated (empty if none)" "" origins
  ask VAULT_STORAGE_LIMIT_MB "Storage per vault in MB" 256 required int
  ask VAULTS_PER_USER "Vaults per account" 50 required int
  ask ACCESS_TOKEN_TTL_SEC "Access token lifetime in seconds" 900 required int
  ask REFRESH_TOKEN_TTL_DAYS "Days a device stays signed in" 60 required int
fi

summary
if [[ ${#REQUIRED_MISSING[@]} -gt 0 ]]; then
  say ""
  fail "Missing required values: ${REQUIRED_MISSING[*]}. Set them in the environment or run without --yes."
fi
if $INTERACTIVE && ! confirm "Write $OUTPUT?" y; then
  say "Nothing written."
  exit 1
fi
write_env

next="docker compose"
[[ $OUTPUT == .env ]] || next+=" --env-file $(printf '%q' "$OUTPUT")"
[[ $database != postgres ]] || next+=" -f compose.postgres.yaml"
next+=" up -d"
say ""
say "Next: ${BOLD}${next}${RESET}"
say "${DIM}Back up $OUTPUT with your database. The keys in it cannot be recovered.${RESET}"
