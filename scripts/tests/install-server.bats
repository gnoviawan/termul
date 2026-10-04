#!/usr/bin/env bats

load "helpers.bash"

MINISIGN_TEST_PUBKEY=$'untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n'

setup() {
  make_tmp
  export HOME="$TERMUL_TEST_TMP_DIR/home"
  export TERMUL_TEST_LOG="$TERMUL_TEST_TMP_DIR/commands.log"
  export TERMUL_INSTALL_BIN_DIR="$TERMUL_TEST_TMP_DIR/bin"
  export TERMUL_INSTALL_STATE_DIR="$TERMUL_TEST_TMP_DIR/state"
  export TERMUL_INSTALL_SYSTEM_UNIT="$TERMUL_TEST_TMP_DIR/no-system.service"
  export TERMUL_INSTALL_USER_UNIT="$TERMUL_TEST_TMP_DIR/no-user.service"
  mkdir -p "$HOME"
  : >"$TERMUL_TEST_LOG"
  unset TERMUL_VERSION
  unset TERMUL_INSTALL_YES
  unset TERMUL_INSTALL_TTY
  unset TERMUL_INSTALL_ASSUME_TTY
  unset XDG_STATE_HOME
  unset _termul_sudo_ok
}

teardown() {
  if [[ -n "${TERMUL_INSTALL_STATE_DIR:-}" && -f "${TERMUL_INSTALL_STATE_DIR}/termul-server.pid" ]]; then
    local pid
    pid="$(tr -cd '0-9' <"${TERMUL_INSTALL_STATE_DIR}/termul-server.pid" || true)"
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  if [[ -n "${TERMUL_INSTALL_BIN_DIR:-}" ]]; then
    pkill -f "${TERMUL_INSTALL_BIN_DIR}/termul-server serve" 2>/dev/null || true
  fi
  unset TERMUL_INSTALL_YES
  unset TERMUL_VERSION
  unset TERMUL_INSTALL_BIN_DIR
  unset TERMUL_INSTALL_STATE_DIR
  unset TERMUL_INSTALL_SYSTEM_UNIT
  unset TERMUL_INSTALL_USER_UNIT
  unset TERMUL_INSTALL_TTY
  unset TERMUL_INSTALL_ASSUME_TTY
  unset TERMUL_FIXTURE_BIN
  unset TERMUL_FIXTURE_SUMS
  unset TERMUL_FIXTURE_SIG
  cleanup_tmp
}

stub_uname() {
  local os="$1"
  local arch="$2"

  stub_cmd uname "
case \"\${1:-}\" in
  -s) printf '%s\\n' '$os' ;;
  -m) printf '%s\\n' '$arch' ;;
  *) exit 1 ;;
esac
"
}

stub_release_curl() {
  stub_cmd curl '
printf "curl %s\n" "$*" >>"$TERMUL_TEST_LOG"
out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
blob=" $* "
if [[ "$blob" == *"SHA256SUMS.txt"* ]]; then
  cp "$TERMUL_FIXTURE_SUMS" "$out"
elif [[ "$blob" == *"termul-server.sig"* ]]; then
  cp "$TERMUL_FIXTURE_SIG" "$out"
elif [[ "$blob" == *"termul-server"* ]]; then
  cp "$TERMUL_FIXTURE_BIN" "$out"
else
  printf "unexpected curl %s\n" "$*" >&2
  exit 1
fi
'
}

write_fake_server() {
  TERMUL_FIXTURE_BIN="$TERMUL_TEST_TMP_DIR/payload.sh"
  TERMUL_FIXTURE_SUMS="$TERMUL_TEST_TMP_DIR/SHA256SUMS.txt"
  TERMUL_FIXTURE_SIG="$TERMUL_TEST_TMP_DIR/termul-server.sig"
  cat >"$TERMUL_FIXTURE_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "onboard" ]]; then
  state="${TERMUL_INSTALL_STATE_DIR:?}"
  mkdir -p "$state"
  setsid "$0" serve >>"${state}/termul-server.log" 2>&1 </dev/null &
  echo $! >"${state}/termul-server.pid"
  exit 0
fi
if [[ "${1:-}" == "serve" ]]; then
  while true; do
    sleep 30
  done
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
EOF
  chmod +x "$TERMUL_FIXTURE_BIN"
  local hash
  hash="$(sha256sum "$TERMUL_FIXTURE_BIN" | awk '{print $1}')"
  printf '%s  termul-server\n' "$hash" >"$TERMUL_FIXTURE_SUMS"
  printf '%s\n' "untrusted comment: test signature" "AAAA" "trusted comment: test" "BBBB" >"$TERMUL_FIXTURE_SIG"
  export TERMUL_FIXTURE_BIN TERMUL_FIXTURE_SUMS TERMUL_FIXTURE_SIG
}

write_prehashed_sig() {
  local dest="$1"
  {
    printf '%s\n' "untrusted comment: signature from minisign secret key"
    printf '%s\n' "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo="
    printf 'trusted comment: timestamp:1556193335\tfile:test\n'
    printf '%s\n' "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg=="
  } >"$dest"
}

@test "detect_os and detect_arch accept Linux x86_64 only" {
  stub_uname Linux x86_64
  load_install_server

  run detect_os
  [ "$status" -eq 0 ]
  [ "$output" = "linux" ]

  run detect_arch
  [ "$status" -eq 0 ]
  [ "$output" = "x86_64" ]
}

@test "detect_os rejects macOS and Windows before any download" {
  stub_uname Darwin arm64
  load_install_server

  run detect_os
  [ "$status" -ne 0 ]
  [[ "$output" == *"macOS is not supported"* ]]
  [[ "$output" == *"Linux x86_64"* ]]

  stub_uname MINGW64_NT-10.0 x86_64
  run detect_os
  [ "$status" -ne 0 ]
  [[ "$output" == *"Windows is not supported"* ]]
}

@test "detect_arch rejects ARM with a clear error" {
  stub_uname Linux aarch64
  load_install_server

  run detect_arch
  [ "$status" -ne 0 ]
  [[ "$output" == *"ARM (aarch64) is not supported"* ]]
  [[ "$output" == *"x86_64"* ]]
}

@test "main rejects ARM before curl" {
  stub_uname Linux aarch64
  stub_cmd curl 'printf "curl %s\n" "$*" >>"$TERMUL_TEST_LOG"; exit 99'
  load_install_server

  run main

  [ "$status" -ne 0 ]
  [[ "$output" == *"ARM (aarch64) is not supported"* ]]
  ! grep -q "^curl " "$TERMUL_TEST_LOG"
}

@test "resolve_version honors TERMUL_VERSION without calling curl" {
  stub_cmd curl 'printf "curl %s\n" "$*" >>"$TERMUL_TEST_LOG"; exit 99'
  load_install_server
  export TERMUL_VERSION="0.4.18"

  run resolve_version

  [ "$status" -eq 0 ]
  [ "$output" = "v0.4.18" ]
  ! grep -q "^curl " "$TERMUL_TEST_LOG"
}

@test "resolve_version rejects a malformed TERMUL_VERSION" {
  load_install_server
  export TERMUL_VERSION="latest"

  run resolve_version

  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid TERMUL_VERSION"* ]]
}

@test "resolve_version parses the latest redirect without api.github.com" {
  stub_cmd curl '
printf "%s\n" "$*" >>"$TERMUL_TEST_LOG"
printf "%s\n" "https://github.com/gnoviawan/termul/releases/tag/v1.2.3"
'
  load_install_server

  run resolve_version

  [ "$status" -eq 0 ]
  [ "$output" = "v1.2.3" ]
  ! grep -q "api.github.com" "$TERMUL_TEST_LOG"
}

@test "resolve_state_dir matches the server default and ignores empty or relative XDG_STATE_HOME" {
  load_install_server
  unset TERMUL_INSTALL_STATE_DIR
  export XDG_STATE_HOME="/tmp/xdg-state"
  export HOME="/tmp/home-state"

  run resolve_state_dir
  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/xdg-state/termul" ]

  export XDG_STATE_HOME=""
  run resolve_state_dir
  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/home-state/.local/state/termul" ]

  export XDG_STATE_HOME="relative/state"
  run resolve_state_dir
  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/home-state/.local/state/termul" ]
}

@test "verify_sha256 accepts a matching termul-server entry and rejects a mismatch" {
  load_install_server
  local payload="$TERMUL_TEST_TMP_DIR/termul-server"
  local sums="$TERMUL_TEST_TMP_DIR/SHA256SUMS.txt"
  printf 'payload' >"$payload"
  local hash
  hash="$(sha256sum "$payload" | awk '{print $1}')"
  printf '%s  termul-server\n' "$hash" >"$sums"

  run verify_sha256 "$payload" "termul-server" "$sums"
  [ "$status" -eq 0 ]

  printf 'tampered' >"$payload"
  run verify_sha256 "$payload" "termul-server" "$sums"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Integrity check failed, nothing was installed"* ]]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
}

@test "verify_minisign_text accepts the official prehashed and legacy vectors" {
  load_install_server
  local msg="$TERMUL_TEST_TMP_DIR/msg"
  local sig="$TERMUL_TEST_TMP_DIR/msg.sig"
  printf 'test' >"$msg"
  write_prehashed_sig "$sig"

  run verify_minisign_text "$msg" "$sig" "$MINISIGN_TEST_PUBKEY"
  [ "$status" -eq 0 ]

  {
    printf '%s\n' "untrusted comment: signature from minisign secret key"
    printf '%s\n' "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA="
    printf 'trusted comment: timestamp:1555779966\tfile:test\n'
    printf '%s\n' "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA=="
  } >"$sig"
  run verify_minisign_text "$msg" "$sig" "$MINISIGN_TEST_PUBKEY"
  [ "$status" -eq 0 ]
}

@test "verify_minisign_text rejects a tampered file and the wrong public key" {
  load_install_server
  local msg="$TERMUL_TEST_TMP_DIR/msg"
  local sig="$TERMUL_TEST_TMP_DIR/msg.sig"
  printf 'Test' >"$msg"
  write_prehashed_sig "$sig"

  run verify_minisign_text "$msg" "$sig" "$MINISIGN_TEST_PUBKEY"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Signature check failed, nothing was installed"* ]]

  printf 'test' >"$msg"
  run verify_minisign "$msg" "$sig"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Signature check failed, nothing was installed"* ]]
}

@test "normalize_minisign_sig accepts Tauri base64-wrapped signatures" {
  load_install_server
  local msg="$TERMUL_TEST_TMP_DIR/msg"
  local raw="$TERMUL_TEST_TMP_DIR/raw.sig"
  local wrapped="$TERMUL_TEST_TMP_DIR/wrapped.sig"
  local normalized="$TERMUL_TEST_TMP_DIR/normalized.sig"
  printf 'test' >"$msg"
  write_prehashed_sig "$raw"
  base64 "$raw" >"$wrapped"

  run normalize_minisign_sig "$wrapped" "$normalized"
  [ "$status" -eq 0 ]
  run verify_minisign_text "$msg" "$normalized" "$MINISIGN_TEST_PUBKEY"
  [ "$status" -eq 0 ]
}

@test "parse_bind reads host and port from a systemd ExecStart line" {
  load_install_server

  run parse_bind 'ExecStart="/usr/local/bin/termul-server" "--host" "0.0.0.0" "--port" "9090"'

  [ "$status" -eq 0 ]
  [ "$output" = "0.0.0.0 9090" ]
}

@test "confirm_install aborts without a tty and proceeds when TERMUL_INSTALL_YES=1" {
  load_install_server
  unset TERMUL_INSTALL_YES

  run confirm_install "Install termul-server?"
  [ "$status" -ne 0 ]
  [[ "$output" == *"TERMUL_INSTALL_YES=1"* ]]

  export TERMUL_INSTALL_YES=1
  run confirm_install "Install termul-server v1.2.3?"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TERMUL_INSTALL_YES=1"* ]]
  [[ "$output" == *"Install termul-server v1.2.3?"* ]]
}

@test "choose_bin_dir prefers an explicit directory, root, then the home fallback" {
  load_install_server

  run choose_bin_dir
  [ "$status" -eq 0 ]
  [ "$output" = "$TERMUL_INSTALL_BIN_DIR" ]

  unset TERMUL_INSTALL_BIN_DIR
  stub_cmd id 'printf "%s\n" "0"'
  run choose_bin_dir
  [ "$status" -eq 0 ]
  [ "$output" = "/usr/local/bin" ]

  _termul_sudo_ok=""
  stub_cmd id 'if [[ "${1:-}" == "-u" ]]; then printf "%s\n" "1000"; else exit 1; fi'
  stub_cmd sudo 'exit 1'
  run choose_bin_dir
  [ "$status" -eq 0 ]
  [[ "$output" == *"$HOME/.local/bin"* ]]
  [[ "$output" == *"sudo is not available"* ]]
}

@test "main aborts a bad checksum and a bad signature before installing" {
  stub_uname Linux x86_64
  write_fake_server
  stub_release_curl
  stub_cmd minisign 'printf "minisign %s\n" "$*" >>"$TERMUL_TEST_LOG"; exit 0'
  export TERMUL_INSTALL_YES=1
  export TERMUL_VERSION=v9.9.9
  export TERMUL_INSTALL_TTY=/dev/null
  export TERMUL_INSTALL_ASSUME_TTY=1
  load_install_server
  printf 'deadbeef  termul-server\n' >"$TERMUL_FIXTURE_SUMS"

  run main
  [ "$status" -ne 0 ]
  [[ "$output" == *"Integrity check failed, nothing was installed"* ]]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
  ! grep -q "^minisign " "$TERMUL_TEST_LOG"

  local hash
  hash="$(sha256sum "$TERMUL_FIXTURE_BIN" | awk '{print $1}')"
  printf '%s  termul-server\n' "$hash" >"$TERMUL_FIXTURE_SUMS"
  stub_cmd minisign 'printf "minisign %s\n" "$*" >>"$TERMUL_TEST_LOG"; exit 1'
  : >"$TERMUL_TEST_LOG"

  run main
  [ "$status" -ne 0 ]
  [[ "$output" == *"Signature check failed, nothing was installed"* ]]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
}

@test "setsid install is idempotent and uninstall keeps or purges state" {
  if [[ -e /usr/local/bin/termul-server ]]; then
    skip "a real termul-server is installed at /usr/local/bin"
  fi

  stub_uname Linux x86_64
  write_fake_server
  stub_release_curl
  stub_cmd minisign 'printf "minisign %s\n" "$*" >>"$TERMUL_TEST_LOG"; exit 0'
  export TERMUL_INSTALL_YES=1
  export TERMUL_VERSION=v9.9.9
  export TERMUL_INSTALL_TTY=/dev/null
  export TERMUL_INSTALL_ASSUME_TTY=1

  run bash "$TERMUL_TEST_REPO_ROOT/scripts/install-server.sh"
  [ "$status" -eq 0 ]
  [ -x "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
  [[ "$output" == *"Checksum verified."* ]]
  [[ "$output" == *"Signature verified."* ]]
  [[ "$output" == *"http://127.0.0.1:8080"* ]]
  [[ "$output" == *"web-auth-token"* ]]
  [[ "$output" == *"cat ${TERMUL_INSTALL_STATE_DIR}/web-auth-token"* ]]
  [[ "$output" == *"tail -f ${TERMUL_INSTALL_STATE_DIR}/termul-server.log"* ]]
  [[ "$output" == *"kill"* ]]
  [[ "$output" == *"Security:"* ]]
  [[ "$output" == *"ssh -L 8080:127.0.0.1:8080"* ]]
  [[ "$output" == *"Installed termul-server and started it."* ]]

  local pid1 pid2
  pid1="$(tr -cd '0-9' <"$TERMUL_INSTALL_STATE_DIR/termul-server.pid")"
  run kill -0 "$pid1"
  [ "$status" -eq 0 ]

  run bash "$TERMUL_TEST_REPO_ROOT/scripts/install-server.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Updated termul-server and restarted it."* ]]
  [[ "$output" == *"Stopping the termul-server that is already running"* ]]
  pid2="$(tr -cd '0-9' <"$TERMUL_INSTALL_STATE_DIR/termul-server.pid")"
  [ "$pid1" != "$pid2" ]
  run kill -0 "$pid1"
  [ "$status" -ne 0 ]
  run kill -0 "$pid2"
  [ "$status" -eq 0 ]

  export TERMUL_PURGE=0
  run bash "$TERMUL_TEST_REPO_ROOT/scripts/uninstall-server.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
  [ -d "$TERMUL_INSTALL_STATE_DIR" ]
  [[ "$output" == *"Keeping"* ]]
  run kill -0 "$pid2"
  [ "$status" -ne 0 ]

  printf 'session\n' >"$TERMUL_INSTALL_STATE_DIR/session"
  export TERMUL_PURGE=1
  run bash "$TERMUL_TEST_REPO_ROOT/scripts/uninstall-server.sh"
  [ "$status" -eq 0 ]
  [ ! -d "$TERMUL_INSTALL_STATE_DIR" ]
  [[ "$output" == *"Deleted"* ]]
}
