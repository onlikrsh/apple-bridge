#!/bin/bash
# Install apple-bridge on Arch Linux. Safe to run again, and do so after every
# `git pull`: the venv, the npm install and the pinned versions are copies.
#
#   ./install.sh                         everything except AirDrop
#   ./install.sh --only calendar,notes   just those parts
#   ./install.sh --yes                   no questions (pacman --noconfirm too)
#
# Parts: calendar (+contacts), reminders, notes, usb, localsend,
#        apps (the macOS-style Notes/Calendar/Reminders), clipboard.
# AirDrop needs particular Wi-Fi hardware and its own sudo rule, so it is a
# separate step: `abridge airdrop check`, then `abridge airdrop install`.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=lib/common.sh
. "$REPO/lib/common.sh"

ALL_PARTS="calendar reminders notes usb localsend apps clipboard"
PARTS="$ALL_PARTS"
USE_PACMAN=1

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --only) PARTS="${2:?--only needs a list}"; PARTS="${PARTS//,/ }"; shift 2 ;;
    --yes|-y) export ABRIDGE_YES=1; shift ;;
    --no-pacman) USE_PACMAN=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
for p in $PARTS; do
  case " $ALL_PARTS " in *" $p "*) ;; *) die "unknown part: $p (choose from: $ALL_PARTS)" ;; esac
done
want() { case " $PARTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

[ "$(id -u)" != 0 ] || die "run this as your normal user; it uses sudo only for pacman"

# First, so that even if a later step fails, `abridge doctor` is there to
# say what is missing.
step "The abridge command"
mkdir -p "$HOME/.local/bin" "$ABRIDGE_CONFIG_DIR" "$ABRIDGE_DATA_DIR" "$ABRIDGE_STATE_DIR"
ln -sfn "$REPO/bin/abridge" "$HOME/.local/bin/abridge"
ok "linked ~/.local/bin/abridge -> $REPO/bin/abridge"

# ---------------------------------------------------------------- packages

packages=(git python libsecret)
want calendar && packages+=(vdirsyncer khal khard)
want reminders && packages+=(todoman)
want notes && packages+=(nodejs npm chromium)
want usb && packages+=(libimobiledevice usbmuxd ifuse rsync libheif)
# The apps run on the system Electron (no npm needed: apps/dist is prebuilt).
# Inter is the open font closest to Apple's SF Pro, which they fall back to.
want apps && packages+=(electron inter-font)
want clipboard && packages+=(wl-clipboard xclip qrencode libnotify iproute2)

step "System packages"
if [ "$USE_PACMAN" = 1 ] && have pacman; then
  # Check each name against the sync database first, so one renamed package
  # is reported by name instead of failing the whole transaction.
  available=() missing=()
  for pkg in "${packages[@]}"; do
    if pacman -Si "$pkg" >/dev/null 2>&1; then available+=("$pkg"); else missing+=("$pkg"); fi
  done
  [ "${#missing[@]}" = 0 ] || warn "not in your repos (try the AUR): ${missing[*]}"
  flags=(--needed)
  [ "${ABRIDGE_YES:-0}" = 1 ] && flags+=(--noconfirm)
  sudo pacman -S "${flags[@]}" "${available[@]}"
  ok "installed: ${available[*]}"
else
  warn "skipping pacman; make sure these are installed: ${packages[*]}"
fi

# ---------------------------------------------------------------- pyicloud

if want reminders; then
  step "pyicloud $ABRIDGE_PYICLOUD_VERSION (Reminders, and \`abridge icloud\`)"
  # An Arch Python upgrade (3.13 -> 3.14) leaves a venv pointing at a
  # library that no longer exists. Rebuild instead of trying to repair it.
  if ! "$ABRIDGE_VENV/bin/python" -c 'import pyicloud' >/dev/null 2>&1; then
    rm -rf "$ABRIDGE_VENV"
    python3 -m venv "$ABRIDGE_VENV"
  fi
  # The [cli] extra is not optional in practice: pyicloud 2.7.0 imports rich
  # at module load, so a bare install cannot even be imported.
  "$ABRIDGE_VENV/bin/pip" install -q --upgrade pip
  "$ABRIDGE_VENV/bin/pip" install -q "pyicloud[cli]==$ABRIDGE_PYICLOUD_VERSION"
  "$ABRIDGE_VENV/bin/icloud" --version >/dev/null || die "pyicloud did not install cleanly"
  ok "$("$ABRIDGE_VENV/bin/icloud" --version | tr -d '\n') in $ABRIDGE_VENV"
fi

# --------------------------------------------------------------- icloud-md

if want notes; then
  step "icloud-md $ABRIDGE_ICLOUD_MD_VERSION (Notes)"
  have node || die "node is not installed"
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' \
    || die "icloud-md needs Node.js 20 or newer"
  # A private prefix: no sudo, no clash with anything else installed globally.
  npm install -g --prefix "$ABRIDGE_NODE_PREFIX" --no-fund --no-audit --loglevel=error \
    "icloud-md@$ABRIDGE_ICLOUD_MD_VERSION"
  [ -x "$ABRIDGE_NODE_PREFIX/bin/icloud-md" ] || die "icloud-md did not install"
  ok "icloud-md in $ABRIDGE_NODE_PREFIX"
  have chromium || warn "no system chromium; icloud-md will download its own browser (~150 MB) at sign-in"
fi

# --------------------------------------------------------------- localsend

if want localsend; then
  step "LocalSend (fast file transfer; the iPhone app is free on the App Store)"
  if have localsend_app || have localsend || pacman -Q localsend-bin >/dev/null 2>&1; then
    ok "already installed"
  elif have paru; then
    paru -S --needed localsend-bin
  elif have yay; then
    yay -S --needed localsend-bin
  elif have flatpak; then
    flatpak install -y flathub org.localsend.localsend_app
  else
    warn "no AUR helper or flatpak found. Install localsend-bin from the AUR yourself"
  fi
fi

# ---------------------------------------------------------------- abridge

step "PATH"
# Arch's default shell setup does not put ~/.local/bin on PATH, so `abridge`
# would be "command not found" right after a successful install.
PATH_CHANGED=0
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ok "$HOME/.local/bin is on your PATH" ;;
  *)
    case "${SHELL##*/}" in
      zsh) rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
      *) rc="" ;;
    esac
    if [ -z "$rc" ]; then
      warn "add $HOME/.local/bin to your PATH (fish: fish_add_path ~/.local/bin)"
    elif grep -qsF '.local/bin' "$rc"; then
      ok "$rc already adds ~/.local/bin; open a new terminal to pick it up"
      PATH_CHANGED=1
    elif confirm "Add ~/.local/bin to your PATH in $rc?" y; then
      # shellcheck disable=SC2016  # written literally, expanded by the shell later
      printf '\n# added by apple-bridge install.sh\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
      ok "added to $rc"
      PATH_CHANGED=1
    else
      warn "add this to $rc yourself: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
    ;;
esac

if want apps; then
  step "Desktop apps"
  "$REPO/bin/abridge" apps install
fi

if want usb; then
  # usbmuxd starts from a udev rule when the phone is plugged in; nothing to
  # enable. Pairing needs the phone unlocked, so it is a later step.
  ok "usb: plug the phone in, unlock it, then run: abridge usb pair"
fi

if [ "${PATH_CHANGED:-0}" = 1 ]; then
  printf '\n%sOpen a new terminal (or run: source %s) before using abridge.%s\n' "$_b" "$rc" "$_n"
fi

cat <<EOF

${_b}Next steps${_n}
  abridge init                 your Apple ID and notes folder
  abridge setup calendar       Calendar + Contacts (needs an app-specific password)
  abridge setup reminders      Reminders (Apple ID password + 2FA code)
  abridge setup notes          Notes, as Markdown files in a git repo
  abridge timer on             keep them in sync every 15 minutes
  abridge pair                 pair the clipboard, USB and the rest
  Notes, Calendar, Reminders   open them from your app menu
  abridge airdrop check        can this laptop's Wi-Fi do AirDrop?
  abridge doctor               see what works
EOF
