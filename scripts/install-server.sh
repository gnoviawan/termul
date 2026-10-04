#!/usr/bin/env bash
# Install the headless termul-server on a Linux x86_64 VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/gnoviawan/termul/dev/scripts/install-server.sh | bash
#
# Downloads the latest GitHub release (or $TERMUL_VERSION), checks SHA256SUMS,
# verifies termul-server.sig with the minisign key from tauri.conf.json, installs
# the binary, then runs `termul-server onboard` with stdin from /dev/tty.
#
# The onboard wizard is interactive. TERMUL_INSTALL_YES=1 skips only this
# script's own confirmation. TERMUL_HOST and TERMUL_PORT are not read:
# onboard has no non-interactive launch path (a non-TTY stdin prints defaults
# and exits without starting the server).
#
# Re-running upgrades the binary and restarts an existing service.
#
# Useful environment:
#   TERMUL_VERSION=v0.4.18     Install this release instead of the latest.
#   TERMUL_INSTALL_YES=1       Skip the installer's yes/no question.
#   TERMUL_INSTALL_BIN_DIR     Install here instead of /usr/local/bin.
#
# Test-only overrides (leave unset on a real machine):
#   TERMUL_INSTALL_STATE_DIR TERMUL_INSTALL_SYSTEM_UNIT TERMUL_INSTALL_USER_UNIT
#   TERMUL_INSTALL_TTY TERMUL_INSTALL_ASSUME_TTY
set -euo pipefail

OWNER="gnoviawan"
REPO="termul"
BASE_URL="https://github.com/${OWNER}/${REPO}"
ASSET_NAME="termul-server"
SIG_NAME="termul-server.sig"

# Minisign public key, decoded from src-tauri/tauri.conf.json
# plugins.updater.pubkey. Same key the desktop updater trusts.
# Do not replace this with a key downloaded at install time.
MINISIGN_PUBLIC_KEY=$'untrusted comment: minisign public key: 6E47FAD95783D992\nRWSS2YNX2fpHbgNnh7tW4A/O7qy7f9uChO/xug/NcqjmtcnmKn4vm2Jv\n'

die() {
  printf '%s\n' "$*" >&2
  return 1
}

is_root() {
  [[ "$(id -u)" -eq 0 ]]
}

detect_os() {
  local os
  os="$(uname -s)"

  case "$os" in
    Linux)
      printf '%s\n' "linux"
      ;;
    Darwin)
      die "macOS is not supported. termul-server releases are Linux x86_64 only. On a Mac, install the desktop app with scripts/install.sh from this repository."
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "Windows is not supported by this installer. termul-server releases are Linux x86_64 only."
      ;;
    *)
      die "Unsupported operating system: ${os}. termul-server releases are Linux x86_64 only."
      ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"

  case "$arch" in
    x86_64 | amd64)
      printf '%s\n' "x86_64"
      ;;
    arm64 | aarch64)
      die "ARM (${arch}) is not supported. termul-server releases are Linux x86_64 only. Use an x86_64 VPS."
      ;;
    *)
      die "Unsupported architecture: ${arch}. termul-server releases are Linux x86_64 only."
      ;;
  esac
}

require_tools() {
  local missing=()
  local tool
  local common_tools=(curl mktemp awk base64 cp chmod mkdir mv tr id uname)

  for tool in "${common_tools[@]}"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing+=("$tool")
    fi
  done

  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    missing+=("sha256sum or shasum")
  fi

  if ! command -v minisign >/dev/null 2>&1; then
    if ! command -v python3 >/dev/null 2>&1; then
      missing+=("python3 or minisign")
    fi
    if ! command -v openssl >/dev/null 2>&1; then
      missing+=("openssl or minisign")
    fi
  fi

  if ((${#missing[@]} > 0)); then
    printf 'Missing required tools:' >&2
    printf ' %s' "${missing[@]}" >&2
    printf '\n' >&2
    return 1
  fi
}

have_sudo() {
  if [[ "${_termul_sudo_ok:-}" == "yes" ]]; then
    return 0
  fi
  if [[ "${_termul_sudo_ok:-}" == "no" ]]; then
    return 1
  fi

  if is_root; then
    _termul_sudo_ok=yes
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    _termul_sudo_ok=no
    return 1
  fi
  if sudo -n true >/dev/null 2>&1; then
    _termul_sudo_ok=yes
    return 0
  fi
  # The redirect is for sudo itself (`sudo -v` reads the password), not a child command.
  # shellcheck disable=SC2024
  if [[ -r /dev/tty ]] && sudo -v </dev/tty; then
    _termul_sudo_ok=yes
    return 0
  fi
  _termul_sudo_ok=no
  return 1
}

can_write_dir() {
  local dir="$1"
  local parent

  if [[ -d "$dir" && -w "$dir" ]]; then
    return 0
  fi
  if [[ ! -e "$dir" ]]; then
    parent="$(dirname "$dir")"
    [[ -d "$parent" && -w "$parent" ]]
    return
  fi
  return 1
}

choose_bin_dir() {
  if [[ -n "${TERMUL_INSTALL_BIN_DIR:-}" ]]; then
    printf '%s\n' "$TERMUL_INSTALL_BIN_DIR"
    return 0
  fi
  if is_root || can_write_dir /usr/local/bin || have_sudo; then
    printf '%s\n' "/usr/local/bin"
    return 0
  fi
  if [[ -z "${HOME:-}" ]]; then
    die "Cannot install: not root, sudo is unavailable, and HOME is unset."
    return 1
  fi
  printf 'sudo is not available. Installing to %s instead of /usr/local/bin.\n' "${HOME}/.local/bin" >&2
  printf '%s\n' "${HOME}/.local/bin"
}

resolve_version() {
  local version="${TERMUL_VERSION:-}"
  local effective_url

  if [[ -n "$version" ]]; then
    if [[ "$version" != v* ]]; then
      version="v${version}"
    fi
    if [[ ! "$version" =~ ^v[0-9]+[.][0-9]+[.][0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
      die "Invalid TERMUL_VERSION: ${TERMUL_VERSION}"
      return 1
    fi
    printf '%s\n' "$version"
    return 0
  fi

  effective_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${BASE_URL}/releases/latest")"
  version="${effective_url##*/}"

  if [[ ! "$version" =~ ^v[0-9]+[.][0-9]+[.][0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
    die "Could not resolve latest Termul version from ${BASE_URL}/releases/latest"
    return 1
  fi

  printf '%s\n' "$version"
}

fetch_sha256sums() {
  local version="$1"
  local output="$2"

  curl -fsSL "${BASE_URL}/releases/download/${version}/SHA256SUMS.txt" -o "$output"
}

download_asset() {
  local version="$1"
  local asset_name="$2"
  local output="$3"

  curl -fL "${BASE_URL}/releases/download/${version}/${asset_name}" -o "$output"
}

hash_file() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

verify_sha256() {
  local file="$1"
  local asset_name="$2"
  local sums_file="$3"
  local expected=""
  local actual

  expected="$(awk -v asset="$asset_name" '
    {
      name = $2
      sub(/^\*/, "", name)
      if (name == asset) { print $1; found = 1; exit }
    }
    END { if (!found) exit 1 }
  ' "$sums_file")" || {
    die "Integrity check failed, nothing was installed: checksum for ${asset_name} not found"
    return 1
  }

  actual="$(hash_file "$file")"
  if [[ "$actual" != "$expected" ]]; then
    die "Integrity check failed, nothing was installed: checksum for ${asset_name} did not match"
    return 1
  fi
}

# Tauri publishes termul-server.sig as base64(minisign text). A raw minisign
# file (first line "untrusted comment:") is accepted too.
normalize_minisign_sig() {
  local src="$1"
  local dest="$2"
  local first=""

  IFS= read -r first <"$src" || true
  if [[ "$first" == "untrusted comment:"* ]]; then
    cp "$src" "$dest"
    return 0
  fi

  if ! base64 -d <"$src" >"$dest" 2>/dev/null; then
    die "Signature check failed, nothing was installed: termul-server.sig is not a minisign signature"
    return 1
  fi
  first=""
  IFS= read -r first <"$dest" || true
  if [[ "$first" != "untrusted comment:"* ]]; then
    die "Signature check failed, nothing was installed: termul-server.sig is not a minisign signature"
    return 1
  fi
}

verify_minisign_text() {
  local file="$1"
  local sig="$2"
  local pubkey="$3"
  local pubfile

  if command -v minisign >/dev/null 2>&1; then
    pubfile="$(mktemp)"
    printf '%s\n' "$pubkey" >"$pubfile"
    if ! minisign -V -p "$pubfile" -m "$file" -x "$sig"; then
      rm -f "$pubfile"
      die "Signature check failed, nothing was installed."
      return 1
    fi
    rm -f "$pubfile"
    return 0
  fi

  if ! TERMUL_MINISIGN_PUBLIC_KEY="$pubkey" python3 - "$file" "$sig" <<'PY'
import base64, hashlib, os, pathlib, subprocess, sys, tempfile

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

def openssl_verify(raw_key, message, signature):
    spki = bytes.fromhex("302a300506032b6570032100") + raw_key
    with tempfile.TemporaryDirectory() as td:
        pub = pathlib.Path(td, "pub.der")
        msg = pathlib.Path(td, "msg")
        sig = pathlib.Path(td, "sig")
        pub.write_bytes(spki)
        msg.write_bytes(message)
        sig.write_bytes(signature)
        result = subprocess.run(
            [
                "openssl", "pkeyutl", "-verify", "-pubin",
                "-inkey", str(pub), "-keyform", "DER",
                "-rawin", "-in", str(msg), "-sigfile", str(sig),
            ],
            capture_output=True,
        )
        if result.returncode != 0 and b"rawin" in result.stderr.lower():
            fail("openssl is too old to verify minisign signatures; install openssl 3 or minisign")
        return result.returncode == 0

file_path, sig_path = sys.argv[1], sys.argv[2]
pub_text = os.environ.get("TERMUL_MINISIGN_PUBLIC_KEY", "")
sig_lines = [line.strip() for line in pathlib.Path(sig_path).read_text(encoding="utf-8").splitlines() if line.strip()]
pub_lines = [line.strip() for line in pub_text.splitlines() if line.strip()]
if len(sig_lines) < 4 or len(pub_lines) < 1:
    fail("minisign signature or public key is incomplete")
try:
    sig_bin = base64.b64decode(sig_lines[1])
    global_sig = base64.b64decode(sig_lines[3])
    pub_bin = base64.b64decode(pub_lines[-1])
except Exception:
    fail("minisign signature or public key is not valid base64")
if len(sig_bin) != 74 or len(global_sig) != 64 or len(pub_bin) != 42:
    fail("minisign signature or public key has an unexpected length")
algorithm = sig_bin[:2]
if algorithm not in (b"Ed", b"ED") or pub_bin[2:10] != sig_bin[2:10]:
    fail("minisign key id does not match the Termul release key")
raw_key = pub_bin[10:42]
data = pathlib.Path(file_path).read_bytes()
message = hashlib.blake2b(data, digest_size=64).digest() if algorithm == b"ED" else data
if not openssl_verify(raw_key, message, sig_bin[10:74]):
    fail("minisign signature did not match this termul-server binary")
trusted = sig_lines[2]
prefix = "trusted comment: "
if not trusted.startswith(prefix):
    fail("minisign signature is missing a trusted comment")
global_message = sig_bin[10:74] + trusted[len(prefix):].encode()
if not openssl_verify(raw_key, global_message, global_sig):
    fail("minisign trusted comment did not verify")
PY
  then
    die "Signature check failed, nothing was installed."
    return 1
  fi
}

verify_minisign() {
  local file="$1"
  local sig="$2"
  local normalized

  normalized="$(mktemp)"
  if ! normalize_minisign_sig "$sig" "$normalized"; then
    rm -f "$normalized"
    return 1
  fi
  if ! verify_minisign_text "$file" "$normalized" "$MINISIGN_PUBLIC_KEY"; then
    rm -f "$normalized"
    return 1
  fi
  rm -f "$normalized"
}

confirm_install() {
  local prompt="$1"
  local reply

  if [[ "${TERMUL_INSTALL_YES:-}" == "1" ]]; then
    printf 'TERMUL_INSTALL_YES=1: %s\n' "$prompt"
    return 0
  fi

  if [[ ! -r /dev/tty ]]; then
    die "Interactive confirmation requires /dev/tty. Set TERMUL_INSTALL_YES=1 to install non-interactively. The setup wizard itself still needs a terminal."
    return 1
  fi

  printf '%s [y/N] ' "$prompt" >/dev/tty
  if ! IFS= read -r reply </dev/tty; then
    die "Interactive confirmation requires /dev/tty. Set TERMUL_INSTALL_YES=1 to install non-interactively. The setup wizard itself still needs a terminal."
    return 1
  fi

  case "$reply" in
    y | Y | yes | YES)
      ;;
    *)
      die "Install cancelled."
      ;;
  esac
}

resolve_state_dir() {
  if [[ -n "${TERMUL_INSTALL_STATE_DIR:-}" ]]; then
    printf '%s\n' "$TERMUL_INSTALL_STATE_DIR"
    return 0
  fi
  # Match ServerConfig::service_account_state_dir on Unix: absolute
  # XDG_STATE_HOME/termul, else ~/.local/state/termul. Empty values fall through.
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

  if [[ -r "/proc/${pid}/cmdline" ]]; then
    cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  fi
  [[ "$cmdline" == *termul-server* ]]
}

pid_is_systemd_main() {
  local pid="$1"
  local main=""
  local unit

  unit="$(system_unit_path)"
  if [[ -f "$unit" ]] && command -v systemctl >/dev/null 2>&1; then
    if [[ -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
      main="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
    else
      main="$(systemctl show -p MainPID --value termul-server 2>/dev/null || true)"
    fi
    if [[ "$main" == "$pid" ]]; then
      return 0
    fi
  fi
  unit="$(user_unit_path)"
  if [[ -f "$unit" ]] && command -v systemctl >/dev/null 2>&1; then
    if [[ -n "${TERMUL_INSTALL_USER_UNIT:-}" ]]; then
      main="$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null || true)"
    else
      main="$(systemctl --user show -p MainPID --value termul-server 2>/dev/null || true)"
    fi
    if [[ "$main" == "$pid" ]]; then
      return 0
    fi
  fi
  return 1
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

stop_existing_setsid() {
  local state pid

  state="$(resolve_state_dir)"
  pid="$(read_pid_file "${state}/termul-server.pid" || true)"
  [[ -n "$pid" ]] || return 0
  if pid_is_systemd_main "$pid"; then
    return 0
  fi
  if ! pid_is_termul_server "$pid"; then
    return 0
  fi
  printf 'Stopping the termul-server that is already running (pid %s) so the new one can take its place.\n' "$pid"
  kill_pid "$pid"
}

install_binary() {
  local src="$1"
  local dest_dir="$2"
  local dest="${dest_dir}/termul-server"
  local tmp="${dest_dir}/.termul-server.new.$$"

  if can_write_dir "$dest_dir"; then
    mkdir -p "$dest_dir"
    cp "$src" "$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$dest"
    return 0
  fi

  if ! have_sudo && ! is_root; then
    die "Cannot write to ${dest_dir} and sudo is not available."
    return 1
  fi
  if is_root; then
    mkdir -p "$dest_dir"
    cp "$src" "$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$dest"
  else
    sudo mkdir -p "$dest_dir"
    sudo cp "$src" "$tmp"
    sudo chmod 755 "$tmp"
    sudo mv -f "$tmp" "$dest"
  fi
}

tty_is_terminal() {
  local tty="$1"

  if [[ "${TERMUL_INSTALL_ASSUME_TTY:-}" == "1" ]]; then
    return 0
  fi
  bash -c '[[ -t 0 ]]' <"$tty"
}

run_onboard() {
  local bin="$1"
  local tty="${TERMUL_INSTALL_TTY:-/dev/tty}"

  if [[ ! -r "$tty" ]]; then
    die "termul-server onboard is interactive and needs a terminal (${tty}). Re-run this installer from a shell. Host and port cannot be passed in the environment; the wizard does not have a non-interactive mode."
    return 1
  fi
  if ! tty_is_terminal "$tty"; then
    die "termul-server onboard is interactive and needs a terminal. Re-run this installer from a shell. TERMUL_INSTALL_YES=1 does not skip the wizard. TERMUL_HOST and TERMUL_PORT are ignored."
    return 1
  fi

  printf '\nStarting the setup wizard. Press Enter to keep each [default].\n' 
  printf 'The wizard asks where the server listens, where your projects live, and then starts it in the background.\n'
  printf 'TERMUL_INSTALL_YES only skipped the question above. This wizard is still interactive.\n\n'

  if ! "$bin" onboard <"$tty"; then
    die "termul-server onboard failed. The program is installed at ${bin}. Fix the problem shown above, then run: ${bin} onboard"
    return 1
  fi
}

restart_installed_services() {
  local unit target

  unit="$(system_unit_path)"
  if [[ -f "$unit" ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
      die "A systemd unit is installed at ${unit} but systemctl was not found, so it was not restarted."
      return 1
    fi
    # An overridden unit path is a test double. Restart that file, not the
    # live termul-server unit name.
    if [[ -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
      target="$unit"
    else
      target="termul-server"
    fi
    if is_root || [[ -w "$unit" || -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
      systemctl daemon-reload
      systemctl restart "$target"
    else
      sudo systemctl daemon-reload
      sudo systemctl restart "$target"
    fi
  fi

  unit="$(user_unit_path)"
  if [[ -f "$unit" ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
      die "A systemd user unit is installed at ${unit} but systemctl was not found, so it was not restarted."
      return 1
    fi
    if [[ -n "${TERMUL_INSTALL_USER_UNIT:-}" ]]; then
      target="$unit"
    else
      target="termul-server"
    fi
    systemctl --user daemon-reload
    systemctl --user restart "$target"
  fi
}

server_is_running() {
  local unit pid state

  unit="$(system_unit_path)"
  if [[ -f "$unit" ]] && command -v systemctl >/dev/null 2>&1; then
    if [[ -n "${TERMUL_INSTALL_SYSTEM_UNIT:-}" ]]; then
      if systemctl is-active --quiet "$unit"; then
        return 0
      fi
    elif systemctl is-active --quiet termul-server; then
      return 0
    fi
  fi
  unit="$(user_unit_path)"
  if [[ -f "$unit" ]] && command -v systemctl >/dev/null 2>&1; then
    if [[ -n "${TERMUL_INSTALL_USER_UNIT:-}" ]]; then
      if systemctl --user is-active --quiet "$unit"; then
        return 0
      fi
    elif systemctl --user is-active --quiet termul-server; then
      return 0
    fi
  fi

  state="$(resolve_state_dir)"
  pid="$(read_pid_file "${state}/termul-server.pid" || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && pid_is_termul_server "$pid"; then
    return 0
  fi
  return 1
}

wait_until_running() {
  local _

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if server_is_running; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

parse_bind() {
  local text="$1"
  local host="127.0.0.1"
  local port="8080"

  if [[ "$text" =~ --host[=[:space:]\"]+([0-9.]+) ]]; then
    host="${BASH_REMATCH[1]}"
  fi
  if [[ "$text" =~ --port[=[:space:]\"]+([0-9]+) ]]; then
    port="${BASH_REMATCH[1]}"
  fi
  printf '%s %s\n' "$host" "$port"
}

discover_bind() {
  local unit text pid state line

  for unit in "$(system_unit_path)" "$(user_unit_path)"; do
    if [[ -f "$unit" ]]; then
      text=""
      while IFS= read -r line || [[ -n "$line" ]]; do
        case "$line" in
          ExecStart=*)
            text="$line"
            break
            ;;
        esac
      done <"$unit"
      if [[ -n "$text" ]]; then
        parse_bind "$text"
        return 0
      fi
    fi
  done

  state="$(resolve_state_dir)"
  pid="$(read_pid_file "${state}/termul-server.pid" || true)"
  if [[ -n "$pid" && -r "/proc/${pid}/cmdline" ]]; then
    text="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
    parse_bind "$text"
    return 0
  fi

  printf '%s %s\n' "127.0.0.1" "8080"
}

print_summary() {
  local bin="$1"
  local upgraded="$2"
  local state token host port system_unit user_unit sudo_prefix log pid

  state="$(resolve_state_dir)"
  token="${state}/web-auth-token"
  read -r host port < <(discover_bind)
  system_unit="$(system_unit_path)"
  user_unit="$(user_unit_path)"

  printf '\n'
  if [[ "$upgraded" == "1" ]]; then
    printf 'Updated termul-server and restarted it.\n'
  else
    printf 'Installed termul-server and started it.\n'
  fi
  printf 'Program: %s\n' "$bin"

  if [[ "$host" == "0.0.0.0" ]]; then
    printf 'URL: http://<this-server>:%s\n' "$port"
    printf 'Bound to 0.0.0.0. In a browser, use this machine'\''s address and port %s (not the text 0.0.0.0).\n' "$port"
  else
    printf 'URL: http://%s:%s\n' "$host" "$port"
  fi

  printf 'Token file: %s\n' "$token"
  if [[ -e "$token" && ! -r "$token" ]]; then
    printf 'Read the token: sudo cat %s\n' "$token"
  else
    printf 'Read the token: cat %s\n' "$token"
  fi
  printf 'A token file is created only when the server binds to 0.0.0.0. Loopback (127.0.0.1) does not use one.\n'
  printf 'Do not paste the token into chat, email, or logs.\n'

  if [[ -f "$system_unit" ]]; then
    sudo_prefix=""
    if ! is_root; then
      sudo_prefix="sudo "
    fi
    printf 'Logs:    %sjournalctl -u termul-server -f\n' "$sudo_prefix"
    printf 'Stop:    %ssystemctl stop termul-server\n' "$sudo_prefix"
    printf 'Restart: %ssystemctl restart termul-server\n' "$sudo_prefix"
  fi
  if [[ -f "$user_unit" ]]; then
    printf 'Logs:    journalctl --user -u termul-server -f\n'
    printf 'Stop:    systemctl --user stop termul-server\n'
    printf 'Restart: systemctl --user restart termul-server\n'
  fi
  if [[ ! -f "$system_unit" && ! -f "$user_unit" ]]; then
    log="${state}/termul-server.log"
    pid="${state}/termul-server.pid"
    printf 'Logs:    tail -f %s\n' "$log"
    printf "Stop:    kill \"\$(cat %s)\"\n" "$pid"
    printf "Restart: kill \"\$(cat %s)\" && %s onboard\n" "$pid" "$bin"
    printf 'Without systemd, the server keeps running after you log out. It does not start again after a reboot; run this installer again if that happens.\n'
  fi

  printf '\nSecurity:\n'
  if [[ "$host" == "0.0.0.0" ]]; then
    printf '  This server is reachable from the network. Prefer binding to 127.0.0.1 and an SSH tunnel,\n'
    printf '  or put an HTTPS reverse proxy in front of it. Plain HTTP on 0.0.0.0 exposes the login token.\n'
  else
    printf '  Staying on 127.0.0.1 is the safer choice. Reach it from your computer with an SSH tunnel:\n'
  fi
  printf '    ssh -L %s:127.0.0.1:%s you@this-server\n' "$port" "$port"
  printf '  Then open http://127.0.0.1:%s on your own computer.\n' "$port"
  printf '  If you later switch the bind address to 0.0.0.0, put HTTPS in front (a reverse proxy) instead of exposing plain HTTP.\n'

  case ":${PATH}:" in
    *":${bin%/*}:"*)
      ;;
    *)
      printf 'Warning: %s is not on PATH. Open a new login shell, or call %s by its full path.\n' "${bin%/*}" "$bin" >&2
      ;;
  esac
}

download_verify_install() {
  local version="$1"
  local bin_dir="$2"
  local tmpdir="$3"
  local sums_file="${tmpdir}/SHA256SUMS.txt"
  local asset_path="${tmpdir}/${ASSET_NAME}"
  local sig_path="${tmpdir}/${SIG_NAME}"
  local bin="${bin_dir}/termul-server"
  local upgraded=0

  if [[ -f "$(system_unit_path)" || -f "$(user_unit_path)" ]] || server_is_running; then
    upgraded=1
  fi

  printf 'Downloading termul-server %s\n' "$version"
  # `|| exit` (not `set -e`) so a failed check cannot continue into install.
  # `set -e` is unreliable inside `if` bodies and under bats' command substitution.
  fetch_sha256sums "$version" "$sums_file" || exit 1
  download_asset "$version" "$ASSET_NAME" "$asset_path" || exit 1
  download_asset "$version" "$SIG_NAME" "$sig_path" || exit 1
  verify_sha256 "$asset_path" "$ASSET_NAME" "$sums_file" || exit 1
  printf 'Checksum verified.\n'
  verify_minisign "$asset_path" "$sig_path" || exit 1
  printf 'Signature verified.\n'

  install_binary "$asset_path" "$bin_dir" || exit 1
  stop_existing_setsid || exit 1
  run_onboard "$bin" || exit 1
  restart_installed_services || exit 1
  if ! wait_until_running; then
    die "termul-server onboard finished but the server does not appear to be running. If the wizard said stdin is not a terminal, re-run this installer from a shell. Otherwise check the messages above and run: ${bin} onboard"
    return 1
  fi
  print_summary "$bin" "$upgraded"
}

main() {
  local os arch version bin_dir tmpdir

  os="$(detect_os)" || return 1
  arch="$(detect_arch)" || return 1
  require_tools || return 1
  version="$(resolve_version)" || return 1
  bin_dir="$(choose_bin_dir)" || return 1

  confirm_install "Install termul-server ${version} (${os}-${arch}) to ${bin_dir}?" || return 1

  tmpdir="$(mktemp -d)"
  (
    set -euo pipefail
    termul_server_tmpdir="$tmpdir"
    trap 'rm -rf "${termul_server_tmpdir:-}"' EXIT
    download_verify_install "$version" "$bin_dir" "$tmpdir" || exit 1
  ) || return 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
