# shellcheck shell=bash
# Paths, versions and helpers shared by bin/abridge and install.sh.
# shellcheck disable=SC2034  # the variables here are used by those scripts

ABRIDGE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/apple-bridge"
ABRIDGE_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/apple-bridge"
ABRIDGE_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/apple-bridge"
ABRIDGE_CONFIG="$ABRIDGE_CONFIG_DIR/config"

# pyicloud keeps its session under /tmp by default, and Arch mounts /tmp as
# tmpfs, so every reboot would mean a fresh password + 2FA. Keep it here.
ABRIDGE_PYICLOUD_SESSION="$ABRIDGE_STATE_DIR/pyicloud"
ABRIDGE_VENV="$ABRIDGE_DATA_DIR/venv"
ABRIDGE_NODE_PREFIX="$ABRIDGE_DATA_DIR/node"
ABRIDGE_SRC_DIR="$ABRIDGE_DATA_DIR/src"
ABRIDGE_APP_PASSWORD_FILE="$ABRIDGE_CONFIG_DIR/app-password"

# Pinned upstream versions. Bump deliberately, after reading their changelogs:
# all of them talk to private Apple services that change without notice.
ABRIDGE_PYICLOUD_VERSION="${ABRIDGE_PYICLOUD_VERSION:-2.7.0}"
ABRIDGE_ICLOUD_MD_VERSION="${ABRIDGE_ICLOUD_MD_VERSION:-0.6.2}"
ABRIDGE_AIRDROP_REPO="${ABRIDGE_AIRDROP_REPO:-https://github.com/jedbillyb/airdrop-mt7921.git}"
ABRIDGE_AIRDROP_REF="${ABRIDGE_AIRDROP_REF:-9f22b77be06a325e66cf600910a494efa71d76d7}"

if [ -t 2 ]; then
  _b=$'\033[1m' _y=$'\033[33m' _r=$'\033[31m' _n=$'\033[0m'
else
  _b='' _y='' _r='' _n=''
fi

step() { printf '\n%s==> %s%s\n' "$_b" "$*" "$_n" >&2; }
ok()   { printf '    ok: %s\n' "$*" >&2; }
warn() { printf '    %swarning:%s %s\n' "$_y" "$_n" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$_r" "$_n" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask a yes/no question; $2 is the default (y or n). ABRIDGE_YES=1 answers yes.
confirm() {
  local prompt="$1" default="${2:-n}" reply
  [ "${ABRIDGE_YES:-0}" = 1 ] && return 0
  if [ "$default" = y ]; then prompt="$prompt [Y/n] "; else prompt="$prompt [y/N] "; fi
  read -r -p "$prompt" reply || return 1
  reply="${reply:-$default}"
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

load_config() {
  APPLE_ID=""
  NOTES_DIR="$HOME/Notes"
  CALENDAR_DIR="$ABRIDGE_DATA_DIR/calendars"
  CONTACTS_DIR="$ABRIDGE_DATA_DIR/contacts"
  REMINDERS_DIR="$ABRIDGE_DATA_DIR/reminders"
  if [ -f "$ABRIDGE_CONFIG" ]; then
    # shellcheck source=/dev/null
    . "$ABRIDGE_CONFIG"
  fi
}

# Values that end up inside vdirsyncer's JSON-valued config. Rejecting the few
# characters that would need escaping is simpler than escaping them.
check_plain() {
  local name="$1" value="$2"
  case "$value" in
    *'"'*|*\\*|*$'\n'*) die "$name contains a quote, backslash or newline: $value" ;;
  esac
}

require_apple_id() {
  [ -n "${APPLE_ID:-}" ] || die "APPLE_ID is not set. Run: abridge init"
  check_plain APPLE_ID "$APPLE_ID"
}
