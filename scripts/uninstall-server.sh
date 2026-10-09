#!/usr/bin/env bash
# Uninstall the headless termul-server on Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/gnoviawan/termul/dev/scripts/uninstall-server.sh | bash
#
# Stops and disables the systemd unit (system and user scope) or the setsid
# process recorded in the state dir, removes the unit file, reloads systemd,
# and removes the termul-server binary.
#
# The state directory (sessions, store, token) is kept unless you confirm
# deletion. TERMUL_PURGE=1 deletes it without asking. TERMUL_PURGE=0 keeps it
# without asking.
#
# Run this as the same user that installed the server. A system-wide install
# needs sudo (the script asks) to remove /usr/local/bin/termul-server and the
# system unit.
#
# Test-only overrides (leave unset on a real machine):
#   TERMUL_INSTALL_BIN_DIR TERMUL_INSTALL_STATE_DIR
#   TERMUL_INSTALL_SYSTEM_UNIT TERMUL_INSTALL_USER_UNIT TERMUL_INSTALL_TTY
set -euo pipefail

die() {
  printf '%s\n' "$*" >&2
  return 1
}

is_root() {
  [[ "$(id -u)" -eq 0 ]]
}

require_linux() {
  local os
  os="$(uname -s)"
  if [[ "$os" != "Linux" ]]; then
    die "This uninstaller only removes the Linux termul-server. This machine is ${os}."
    return 1
  fi
}

resolve_state_dir() {
  if [[ -n "${TERMUL_INSTALL_STATE_DIR:-}" ]]; then
    printf '%s\n' "$TERMUL_INSTALL_STATE_DIR"
    return 0
  fi
  # Match ServerConfig::service_account_state_dir on Unix.
  if [[ -n "${XDG_STATE_HOME:-}" && "${XDG_STATE_HOME}" == /* ]]; then
    printf '%s\n' "${XDG_STATE_HOME}/termul"
    return 0
  fi
  if [[ -n "${HOME:-}" ]]; then
    printf '%s\n' "${HOME}/.local/state/termul"
    return 0
  fi
  printf '%s\n' "${TMPDIR:-/tmp}/termul"
}

system_unit_path() {
  printf '%s\n' "${TERMUL_INSTALL_SYSTEM_UNIT:-/etc/systemd/system/termul-server.service}"
}

user_unit_path() {
  local home="${HOME:-.}"
  printf '%s\n' "${TERMUL_INSTALL_USER_UNIT:-${home}/.config/systemd/user/termul-server.service}"
}

read_pid_file() {
  local file="$1"
  local pid=""

  [[ -f "$file" ]] || return 1
  IFS= read -r pid <"$file" || true
  pid="${pid//[^0-9]/}"
  [[ -n "$pid" ]] || return 1
  if [[ "$pid" -le 1 ]]; then
    return 1
  fi
  printf '%s\n' "$pid"
}

pid_is_termul_server() {
  local pid="$1"
  local cmdline=""

  if [[ ! -r "/proc/${pid}/cmdline" ]]; then
    return 1
  fi
  cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  [[ "$cmdline" == *termul-server* ]]
}

kill_pid() {
  local pid="$1"
  local _

  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
}

remove_file() {
  local path="$1"
  [[ -e "$path" || -L "$path" ]] || return 0
  if [[ -w "$path" || -w "${path%/*}" ]]; then
    rm -f "$path"
    return 0
  fi
  if is_root; then
    rm -f "$path"
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo rm -f "$path"
    return 0
  fi
  die "Cannot remove ${path}. Re-run this uninstaller with sudo."
  return 1
}

run_systemctl() {
  if is_root || ! command -v sudo >/dev/null 2>&1; then
    systemctl "$@"
  else
    sudo systemctl "$@"
  fi
}

stop_system_unit() {
  local unit target
  unit="$(system_unit_path)"
  [[ -f "$unit" || -L "$unit" ]] || return 0

  if [[ -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
    target="$unit"
  else
    target="termul-server"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    if is_root || [[ -w "$unit" || -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
      systemctl disable --now "$target" || true
    else
      run_systemctl disable --now "$target" || true
    fi
  else
    printf 'systemctl was not found. Removed the unit file without disabling it in systemd.\n' >&2
  fi
  remove_file "$unit"
  if command -v systemctl >/dev/null 2>&1; then
    if is_root || [[ -w "$unit" || -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
      systemctl daemon-reload || true
    else
      run_systemctl daemon-reload || true
    fi
  fi
  printf 'Removed systemd unit %s\n' "$unit"
}

stop_user_unit() {
  local unit target
  unit="$(user_unit_path)"
  [[ -f "$unit" || -L "$unit" ]] || return 0

  if [[ -n "${TERMUL_INSTALL_USER_UNIT:-}" ]]; then
    target="$unit"
  else
    target="termul-server"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$target" || true
  fi
  remove_file "$unit"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload || true
  fi
  printf 'Removed systemd user unit %s\n' "$unit"
}

stop_setsid() {
  local state pid
  state="$(resolve_state_dir)"
  pid="$(read_pid_file "${state}/termul-server.pid" || true)"
  if [[ -n "$pid" ]]; then
    if pid_is_termul_server "$pid"; then
      printf 'Stopping termul-server process %s\n' "$pid"
      kill_pid "$pid"
    else
      printf 'Pid file lists %s, which is not termul-server. Leaving that process alone.\n' "$pid" >&2
    fi
  fi
  if [[ -f "${state}/termul-server.pid" ]]; then
    remove_file "${state}/termul-server.pid"
    printf 'Removed %s\n' "${state}/termul-server.pid"
  fi
}

remove_binaries() {
  local path home_bin
  local -a paths=()

  if [[ -n "${TERMUL_INSTALL_BIN_DIR:-}" ]]; then
    paths+=("${TERMUL_INSTALL_BIN_DIR}/termul-server")
  fi
  paths+=("/usr/local/bin/termul-server")
  if [[ -n "${HOME:-}" ]]; then
    home_bin="${HOME}/.local/bin/termul-server"
    paths+=("$home_bin")
  fi

  local seen=" "
  for path in "${paths[@]}"; do
    if [[ "$seen" == *" ${path} "* ]]; then
      continue
    fi
    seen="${seen}${path} "
    if [[ -f "$path" || -L "$path" ]]; then
      remove_file "$path"
      printf 'Removed %s\n' "$path"
    fi
  done
}

state_dir_is_safe_to_delete() {
  local state="$1"

  if [[ -z "$state" || "$state" == "/" || "$state" == "/home" || "$state" == "/root" || "$state" == "/tmp" || "$state" == "/var" ]]; then
    die "Refusing to delete ${state:-<empty>}."
    return 1
  fi
  if [[ -n "${HOME:-}" && "$state" == "$HOME" ]]; then
    die "Refusing to delete ${state}."
    return 1
  fi
  if [[ -L "$state" ]]; then
    die "Refusing to delete ${state}: it is a symlink."
    return 1
  fi
  if [[ -n "${TERMUL_INSTALL_STATE_DIR:-}" && "$state" == "$TERMUL_INSTALL_STATE_DIR" ]]; then
    return 0
  fi
  case "$state" in
    */termul)
      return 0
      ;;
    *)
      die "Refusing to delete ${state} (expected a termul state directory)."
      return 1
      ;;
  esac
}

prompt_purge() {
  local state="$1"
  local reply=""
  local tty

  if [[ ! -d "$state" ]]; then
    return 1
  fi
  if [[ "${TERMUL_PURGE:-}" == "1" ]]; then
    printf 'TERMUL_PURGE=1: deleting %s\n' "$state"
    return 0
  fi
  if [[ "${TERMUL_PURGE:-}" == "0" ]]; then
    printf 'Keeping %s\n' "$state"
    return 1
  fi

  tty="${TERMUL_INSTALL_TTY:-/dev/tty}"
  if [[ ! -r "$tty" ]]; then
    printf 'Keeping %s (no terminal to ask). Set TERMUL_PURGE=1 to delete sessions, store, and token.\n' "$state"
    return 1
  fi

  if [[ -w /dev/tty ]]; then
    printf 'Delete %s (sessions, store, and token)? [y/N] ' "$state" >/dev/tty
  else
    printf 'Delete %s (sessions, store, and token)? [y/N] ' "$state" >&2
  fi
  IFS= read -r reply <"$tty" || true
  case "$reply" in
    y | Y | yes | YES)
      return 0
      ;;
    *)
      printf 'Keeping %s\n' "$state"
      return 1
      ;;
  esac
}

purge_state_dir() {
  local state
  state="$(resolve_state_dir)"
  if [[ ! -d "$state" ]]; then
    printf 'No state directory at %s\n' "$state"
    return 0
  fi
  if prompt_purge "$state"; then
    state_dir_is_safe_to_delete "$state" || return 1
    if [[ -w "${state%/*}" ]]; then
      rm -rf "$state"
    elif is_root; then
      rm -rf "$state"
    elif command -v sudo >/dev/null 2>&1; then
      sudo rm -rf "$state"
    else
      die "Cannot delete ${state}. Re-run this uninstaller with sudo."
      return 1
    fi
    printf 'Deleted %s\n' "$state"
  fi
}

main() {
  require_linux || return 1
  printf 'Uninstalling termul-server.\n'
  stop_system_unit
  stop_user_unit
  stop_setsid
  remove_binaries
  purge_state_dir
  printf '\ntermul-server has been uninstalled.\n'
  printf 'The desktop app, if you installed it separately, was not touched.\n'
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
