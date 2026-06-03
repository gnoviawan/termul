#!/usr/bin/env bats

load "helpers.bash"

fixture_sums="$TERMUL_TEST_REPO_ROOT/scripts/tests/fixtures/SHA256SUMS.txt"

setup() {
  make_tmp
  export HOME="$TERMUL_TEST_TMP_DIR/home"
  export TERMUL_TEST_LOG="$TERMUL_TEST_TMP_DIR/commands.log"
  export TERMUL_INSTALL_APPLICATIONS_DIR="$TERMUL_TEST_TMP_DIR/Applications"
  export TERMUL_INSTALL_BIN_DIR="$HOME/.local/bin"
  export TERMUL_INSTALL_DESKTOP_DIR="$HOME/.local/share/applications"
  mkdir -p "$HOME" "$TERMUL_INSTALL_APPLICATIONS_DIR"
  : >"$TERMUL_TEST_LOG"
}

teardown() {
  unset TERMUL_INSTALL_YES
  unset TERMUL_INSTALL_APPLICATIONS_DIR
  unset TERMUL_INSTALL_BIN_DIR
  unset TERMUL_INSTALL_DESKTOP_DIR
  cleanup_tmp
}

stub_uname() {
  local os="$1"
  local arch="$2"

  stub_cmd uname "
case \"\$1\" in
  -s) printf '%s\\n' '$os' ;;
  -m) printf '%s\\n' '$arch' ;;
  *) exit 1 ;;
esac
"
}

stub_common_tools() {
  stub_cmd curl "printf 'curl %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\""
  stub_cmd mktemp "if [[ \"\${1:-}\" == '-d' ]]; then dir=\"\$TERMUL_TEST_TMP_DIR/mktemp.\$RANDOM\"; mkdir -p \"\$dir\"; printf '%s\\n' \"\$dir\"; else file=\"\$TERMUL_TEST_TMP_DIR/mktemp.\$RANDOM\"; : >\"\$file\"; printf '%s\\n' \"\$file\"; fi"
}

stub_curl_release_flow() {
  local payload="$1"

  stub_cmd curl "
printf 'curl %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
args=\" \$* \"
if [[ \"\$args\" == *'/releases/latest'* ]]; then
  printf '%s\\n' 'https://github.com/gnoviawan/termul/releases/tag/v1.2.3'
  exit 0
fi
out=''
prev=''
for arg in \"\$@\"; do
  if [[ \"\$prev\" == '-o' ]]; then
    out=\"\$arg\"
    break
  fi
  prev=\"\$arg\"
done
if [[ \"\$args\" == *'SHA256SUMS.txt'* ]]; then
  /bin/cp '$fixture_sums' \"\$out\"
else
  printf '%s' '$payload' >\"\$out\"
fi
"
}

stub_macos_install_tools() {
  stub_cmd hdiutil "
printf 'hdiutil %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
if [[ \"\$1\" == 'attach' ]]; then
  mountpoint=''
  prev=''
  for arg in \"\$@\"; do
    if [[ \"\$prev\" == '-mountpoint' ]]; then
      mountpoint=\"\$arg\"
      break
    fi
    prev=\"\$arg\"
  done
  mkdir -p \"\$mountpoint/Termul Manager.app\"
fi
"
  stub_cmd cp "
printf 'cp %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
if [[ \"\${TERMUL_TEST_CP_FAIL_ONCE:-}\" == '1' && ! -f \"\$TERMUL_TEST_TMP_DIR/cp_failed\" ]]; then
  : >\"\$TERMUL_TEST_TMP_DIR/cp_failed\"
  exit 1
fi
exit 0
"
  stub_cmd sudo "printf 'sudo %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\""
  stub_cmd xattr "printf 'xattr %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\""
}

stub_logging_rm() {
  stub_cmd rm "
printf 'rm %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
/bin/rm \"\$@\"
"
}

stub_linux_install_tools() {
  stub_cmd cp "
printf 'cp %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
command cp \"\$@\"
"
  stub_cmd chmod "
printf 'chmod %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
command chmod \"\$@\"
"
}

@test "detect_os and detect_arch normalize supported Darwin and Linux pairs" {
  stub_uname Darwin arm64
  load_install

  run detect_os
  [ "$status" -eq 0 ]
  [ "$output" = "darwin" ]

  run detect_arch
  [ "$status" -eq 0 ]
  [ "$output" = "aarch64" ]

  stub_uname Linux x86_64
  run detect_os
  [ "$status" -eq 0 ]
  [ "$output" = "linux" ]

  run detect_arch
  [ "$status" -eq 0 ]
  [ "$output" = "x86_64" ]
}

@test "detect_os and detect_arch reject unsupported platforms" {
  stub_uname FreeBSD sparc
  load_install

  run detect_os
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported operating system"* ]]

  stub_uname Linux sparc
  run detect_arch
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported architecture"* ]]
}

@test "main rejects Windows shells before curl download" {
  stub_uname MINGW64_NT-10.0 x86_64
  stub_common_tools
  load_install

  run main

  [ "$status" -ne 0 ]
  [[ "$output" == *".exe or .msi"* ]]
  [[ "$output" == *"https://github.com/gnoviawan/termul/releases"* ]]
  ! grep -q "^curl " "$TERMUL_TEST_LOG"
}

@test "require_tools fails early and names missing tools before download" {
  stub_uname Darwin arm64
  load_install
  PATH="$TERMUL_TEST_STUB_BIN"

  run main

  [ "$status" -ne 0 ]
  [[ "$output" == *"Missing required tools"* ]]
  [[ "$output" == *"curl"* ]]
  [[ "$output" == *"mktemp"* ]]
  ! grep -q "curl" "$TERMUL_TEST_LOG"
}

@test "resolve_version parses latest redirect without api.github.com" {
  stub_cmd curl "
printf '%s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
printf '%s\\n' 'https://github.com/gnoviawan/termul/releases/tag/v1.2.3'
"
  load_install

  run resolve_version

  [ "$status" -eq 0 ]
  [ "$output" = "v1.2.3" ]
  ! grep -q "api.github.com" "$TERMUL_TEST_LOG"
  grep -q "https://github.com/gnoviawan/termul/releases/latest" "$TERMUL_TEST_LOG"
}

@test "verify_sha256 succeeds for matching fixture" {
  load_install
  local payload="$TERMUL_TEST_TMP_DIR/Termul.Manager_1.2.3_amd64.AppImage"
  printf '%s' "linux appimage payload" >"$payload"

  run verify_sha256 "$payload" "Termul.Manager_1.2.3_amd64.AppImage" "$fixture_sums"

  [ "$status" -eq 0 ]
}

@test "verify_sha256 fails missing and mismatched entries without creating install targets" {
  load_install
  local payload="$TERMUL_TEST_TMP_DIR/payload"
  local target="$TERMUL_INSTALL_BIN_DIR/termul-manager"
  printf '%s' "tampered payload" >"$payload"

  run verify_sha256 "$payload" "Termul.Manager_9.9.9_amd64.AppImage" "$fixture_sums"
  [ "$status" -ne 0 ]
  [[ "$output" == *"integritas gagal, tidak menginstall apa pun"* ]]
  [ ! -e "$target" ]

  run verify_sha256 "$payload" "Termul.Manager_1.2.3_amd64.AppImage" "$fixture_sums"
  [ "$status" -ne 0 ]
  [[ "$output" == *"integritas gagal, tidak menginstall apa pun"* ]]
  [ ! -e "$target" ]
}

@test "confirm_install aborts non-tty without env var" {
  load_install
  unset TERMUL_INSTALL_YES

  run confirm_install "Install Termul Manager?"

  [ "$status" -ne 0 ]
  [[ "$output" == *"TERMUL_INSTALL_YES=1"* ]]
}

@test "confirm_install proceeds with env var and echoes prompt" {
  load_install
  export TERMUL_INSTALL_YES=1

  run confirm_install "Install Termul Manager v1.2.3?"

  [ "$status" -eq 0 ]
  [[ "$output" == *"TERMUL_INSTALL_YES=1"* ]]
  [[ "$output" == *"Install Termul Manager v1.2.3?"* ]]
}

@test "install_macos downloads correct DMG, verifies before copy fallback, detaches, then xattrs" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  export TERMUL_TEST_CP_FAIL_ONCE=1
  load_install

  run install_macos "v1.2.3" "aarch64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -q "releases/download/v1.2.3/Termul.Manager_1.2.3_aarch64.dmg" "$TERMUL_TEST_LOG"
  ! grep -q "Termul.Manager_v1.2.3_aarch64.dmg" "$TERMUL_TEST_LOG"
  local verify_line
  local attach_line
  local cp_line
  local sudo_line
  local detach_line
  local xattr_line
  verify_line="$(grep -n "curl .*Termul.Manager_1.2.3_aarch64.dmg" "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  attach_line="$(grep -n "hdiutil attach" "$TERMUL_TEST_LOG" | cut -d: -f1)"
  cp_line="$(grep -n "^cp " "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  sudo_line="$(grep -n "^sudo cp" "$TERMUL_TEST_LOG" | cut -d: -f1)"
  detach_line="$(grep -n "hdiutil detach" "$TERMUL_TEST_LOG" | cut -d: -f1)"
  xattr_line="$(grep -n "^xattr " "$TERMUL_TEST_LOG" | cut -d: -f1)"
  [ "$verify_line" -lt "$attach_line" ]
  [ "$attach_line" -lt "$cp_line" ]
  [ "$cp_line" -lt "$sudo_line" ]
  [ "$sudo_line" -lt "$detach_line" ]
  [ "$detach_line" -lt "$xattr_line" ]
}

@test "install_macos detaches mounted DMG on copy failure" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  stub_cmd cp "printf 'cp %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"; exit 1"
  stub_cmd sudo "printf 'sudo %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"; exit 1"
  load_install

  run install_macos "v1.2.3" "x86_64" "$fixture_sums"

  [ "$status" -ne 0 ]
  grep -q "Termul.Manager_1.2.3_x64.dmg" "$TERMUL_TEST_LOG"
  ! grep -q "Termul.Manager_v1.2.3_x64.dmg" "$TERMUL_TEST_LOG"
  grep -q "hdiutil detach" "$TERMUL_TEST_LOG"
}

@test "install_macos replaces existing app bundle before copying" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  stub_logging_rm
  mkdir -p "$TERMUL_INSTALL_APPLICATIONS_DIR/Termul Manager.app"
  load_install

  run install_macos "v1.2.3" "aarch64" "$fixture_sums"

  [ "$status" -eq 0 ]
  local rm_line
  local cp_line
  rm_line="$(grep -n "^rm -rf .*Termul Manager.app" "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  cp_line="$(grep -n "^cp -R " "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  [ -n "$rm_line" ]
  [ -n "$cp_line" ]
  [ "$rm_line" -lt "$cp_line" ]
}

@test "install_linux installs AppImage, desktop entry, chmod, and PATH warning" {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install

  run install_linux "v1.2.3" "x86_64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -q "releases/download/v1.2.3/Termul.Manager_1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
  ! grep -q "Termul.Manager_v1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
  [ -x "$TERMUL_INSTALL_BIN_DIR/termul-manager" ]
  [ -f "$TERMUL_INSTALL_DESKTOP_DIR/termul-manager.desktop" ]
  grep -q "Exec=$TERMUL_INSTALL_BIN_DIR/termul-manager" "$TERMUL_INSTALL_DESKTOP_DIR/termul-manager.desktop"
  [[ "$output" == *"not in PATH"* ]]
}

@test "main happy macOS path reaches hdiutil once" {
  stub_uname Darwin arm64
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  export TERMUL_INSTALL_YES=1
  load_install

  run main

  [ "$status" -eq 0 ]
  [[ "$output" == *"Install Termul Manager v1.2.3 (darwin-aarch64) to /Applications?"* ]]
  [ "$(grep -c "hdiutil attach" "$TERMUL_TEST_LOG")" -eq 1 ]
}

@test "main happy Linux prompt includes platform tuple and installs AppImage" {
  stub_uname Linux x86_64
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  export TERMUL_INSTALL_YES=1
  load_install

  run main

  [ "$status" -eq 0 ]
  [[ "$output" == *"Install Termul Manager v1.2.3 (linux-x86_64) to $HOME/.local/bin?"* ]]
  [ -x "$TERMUL_INSTALL_BIN_DIR/termul-manager" ]
  grep -q "Termul.Manager_1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
  ! grep -q "Termul.Manager_v1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
}

@test "main non-tty abort runs no install commands" {
  stub_uname Darwin arm64
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  unset TERMUL_INSTALL_YES
  load_install

  run main

  [ "$status" -ne 0 ]
  ! grep -q "hdiutil" "$TERMUL_TEST_LOG"
  ! grep -q "^cp " "$TERMUL_TEST_LOG"
  ! grep -q "xattr" "$TERMUL_TEST_LOG"
}

@test "main tampered download aborts before hdiutil cp or xattr" {
  stub_uname Darwin arm64
  stub_common_tools
  stub_curl_release_flow "tampered payload"
  stub_macos_install_tools
  export TERMUL_INSTALL_YES=1
  load_install

  run main

  [ "$status" -ne 0 ]
  [[ "$output" == *"integritas gagal, tidak menginstall apa pun"* ]]
  ! grep -q "hdiutil" "$TERMUL_TEST_LOG"
  ! grep -q "^cp " "$TERMUL_TEST_LOG"
  ! grep -q "xattr" "$TERMUL_TEST_LOG"
}
