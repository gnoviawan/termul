#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

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
  unset TROUPE_INSTALL_YES
  unset TROUPE_INSTALL_APPLICATIONS_DIR
  unset TROUPE_INSTALL_BIN_DIR
  unset TROUPE_INSTALL_DESKTOP_DIR
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
  mkdir -p \"\$mountpoint/Troupe.app\" \"\$mountpoint/Termul Manager.app\"
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
  # Stubs are `#!/usr/bin/env bash` scripts, so bash must stay resolvable
  # once PATH is narrowed to the stub dir; nothing else from the system leaks in.
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v bash)" >"$TERMUL_TEST_STUB_BIN/bash"
  chmod +x "$TERMUL_TEST_STUB_BIN/bash"
  local saved_path="$PATH"
  PATH="$TERMUL_TEST_STUB_BIN"

  run main

  PATH="$saved_path"

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
  local payload="$TERMUL_TEST_TMP_DIR/Troupe_1.2.3_amd64.AppImage"
  printf '%s' "linux appimage payload" >"$payload"

  run verify_sha256 "$payload" "Troupe_1.2.3_amd64.AppImage" "$fixture_sums"

  [ "$status" -eq 0 ]
}

@test "verify_sha256 fails missing and mismatched entries without creating install targets" {
  load_install
  local payload="$TERMUL_TEST_TMP_DIR/payload"
  local target="$TERMUL_INSTALL_BIN_DIR/troupe"
  printf '%s' "tampered payload" >"$payload"

  run verify_sha256 "$payload" "Troupe_9.9.9_amd64.AppImage" "$fixture_sums"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Integrity check failed, nothing was installed"* ]]
  [ ! -e "$target" ]

  run verify_sha256 "$payload" "Troupe_1.2.3_amd64.AppImage" "$fixture_sums"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Integrity check failed, nothing was installed"* ]]
  [ ! -e "$target" ]
}

@test "confirm_install aborts non-tty without env var" {
  load_install
  unset TERMUL_INSTALL_YES

  run confirm_install "Install Termul Manager?"

  [ "$status" -ne 0 ]
  [[ "$output" == *"Set TROUPE_INSTALL_YES=1 to install non-interactively."* ]]
}

@test "confirm_install proceeds with env var and echoes prompt" {
  load_install
  export TERMUL_INSTALL_YES=1

  run confirm_install "Install Termul Manager v1.2.3?"

  [ "$status" -eq 0 ]
  [ "$output" = "TROUPE_INSTALL_YES=1: Install Termul Manager v1.2.3?" ]
}

@test "confirm_install proceeds with the TROUPE_ name" {
  load_install
  export TROUPE_INSTALL_YES=1

  run confirm_install "Install Termul Manager v1.2.3?"

  [ "$status" -eq 0 ]
  [ "$output" = "TROUPE_INSTALL_YES=1: Install Termul Manager v1.2.3?" ]
}

@test "brand_env prefers TROUPE_, falls back to TERMUL_, and ignores a blank TROUPE_" {
  load_install

  TROUPE_INSTALL_BIN_DIR=/new TERMUL_INSTALL_BIN_DIR=/old run brand_env INSTALL_BIN_DIR
  [ "$output" = "/new" ]
  TERMUL_INSTALL_BIN_DIR=/old run brand_env INSTALL_BIN_DIR
  [ "$output" = "/old" ]
  TROUPE_INSTALL_BIN_DIR= TERMUL_INSTALL_BIN_DIR=/old run brand_env INSTALL_BIN_DIR
  [ "$output" = "/old" ]
  TROUPE_INSTALL_BIN_DIR="  " TERMUL_INSTALL_BIN_DIR=/old run brand_env INSTALL_BIN_DIR
  [ "$output" = "/old" ]
  unset TERMUL_INSTALL_BIN_DIR
  run brand_env INSTALL_BIN_DIR
  [ "$output" = "" ]
}

@test "note_legacy_env names each old variable once and skips renamed ones" {
  load_install
  unset TERMUL_INSTALL_APPLICATIONS_DIR TERMUL_INSTALL_DESKTOP_DIR
  export TERMUL_INSTALL_YES=1
  export TROUPE_INSTALL_BIN_DIR=/new

  run --separate-stderr note_legacy_env

  [ "$status" -eq 0 ]
  [ "$stderr" = "TERMUL_INSTALL_YES is deprecated; rename it to TROUPE_INSTALL_YES (TERMUL_INSTALL_YES still works for now)" ]
}

@test "install_linux installs into TROUPE_INSTALL_BIN_DIR over the TERMUL_ name" {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install
  export TROUPE_INSTALL_BIN_DIR="$HOME/troupe-bin"

  run install_linux "v1.2.3" "x86_64" "$fixture_sums"

  [ "$status" -eq 0 ]
  [ "$(cat "$HOME/troupe-bin/troupe.AppImage")" = "linux appimage payload" ]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/troupe.AppImage" ]
}

@test "install_macos downloads correct DMG, verifies before copy fallback, detaches, then xattrs" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  export TERMUL_TEST_CP_FAIL_ONCE=1
  load_install

  run install_macos "v1.2.3" "aarch64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -q "releases/download/v1.2.3/Troupe_1.2.3_aarch64.dmg" "$TERMUL_TEST_LOG"
  ! grep -q "Troupe_v1.2.3_aarch64.dmg" "$TERMUL_TEST_LOG"
  local verify_line
  local attach_line
  local cp_line
  local sudo_line
  local detach_line
  local xattr_line
  verify_line="$(grep -n "curl .*Troupe_1.2.3_aarch64.dmg" "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
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
  grep -q "Troupe_1.2.3_x64.dmg" "$TERMUL_TEST_LOG"
  ! grep -q "Troupe_v1.2.3_x64.dmg" "$TERMUL_TEST_LOG"
  grep -q "hdiutil detach" "$TERMUL_TEST_LOG"
}

@test "install_macos replaces existing app bundle before copying" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  stub_logging_rm
  mkdir -p "$TERMUL_INSTALL_APPLICATIONS_DIR/Troupe.app"
  load_install

  run install_macos "v1.2.3" "aarch64" "$fixture_sums"

  [ "$status" -eq 0 ]
  local rm_line
  local cp_line
  rm_line="$(grep -n "^rm -rf .*Troupe.app" "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  cp_line="$(grep -n "^cp -R " "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  [ -n "$rm_line" ]
  [ -n "$cp_line" ]
  [ "$rm_line" -lt "$cp_line" ]
}

@test "install_macos removes the pre-rename Termul Manager bundle after installing Troupe" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  stub_logging_rm
  mkdir -p "$TERMUL_INSTALL_APPLICATIONS_DIR/Termul Manager.app"
  load_install

  run install_macos "v1.2.3" "aarch64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -Fq "/mount/Troupe.app $TERMUL_INSTALL_APPLICATIONS_DIR/" "$TERMUL_TEST_LOG"
  local cp_line
  local rm_line
  cp_line="$(grep -n "^cp -R " "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  rm_line="$(grep -Fn "rm -rf $TERMUL_INSTALL_APPLICATIONS_DIR/Termul Manager.app" "$TERMUL_TEST_LOG" | head -n1 | cut -d: -f1)"
  [ -n "$rm_line" ]
  [ "$cp_line" -lt "$rm_line" ]
  [ ! -e "$TERMUL_INSTALL_APPLICATIONS_DIR/Termul Manager.app" ]
}

@test "install_macos installs a pre-rename release under its Termul Manager names" {
  stub_common_tools
  stub_curl_release_flow "mac dmg payload"
  stub_macos_install_tools
  stub_logging_rm
  mkdir -p "$TERMUL_INSTALL_APPLICATIONS_DIR/Termul Manager.app"
  load_install

  run install_macos "v0.4.60" "aarch64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -q "releases/download/v0.4.60/Termul.Manager_0.4.60_aarch64.dmg" "$TERMUL_TEST_LOG"
  grep -Fq "/mount/Termul Manager.app $TERMUL_INSTALL_APPLICATIONS_DIR/" "$TERMUL_TEST_LOG"
  [ "$(grep -Fc "rm -rf $TERMUL_INSTALL_APPLICATIONS_DIR/Termul Manager.app" "$TERMUL_TEST_LOG")" -eq 1 ]
}

@test "install_linux downloads a pre-rename release under its Termul Manager asset name" {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install

  run install_linux "v0.4.60" "x86_64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -q "releases/download/v0.4.60/Termul.Manager_0.4.60_amd64.AppImage" "$TERMUL_TEST_LOG"
  grep -Fxq "Name=Termul Manager" "$TERMUL_INSTALL_DESKTOP_DIR/troupe.desktop"
}

@test "install_linux installs AppImage, desktop entry, chmod, and PATH warning" {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install

  run install_linux "v1.2.3" "x86_64" "$fixture_sums"

  [ "$status" -eq 0 ]
  grep -q "releases/download/v1.2.3/Troupe_1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
  ! grep -q "Troupe_v1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
  [ -x "$TERMUL_INSTALL_BIN_DIR/troupe" ]
  [ "$(cat "$TERMUL_INSTALL_BIN_DIR/troupe.AppImage")" = "linux appimage payload" ]
  [ "$(cat "$TERMUL_INSTALL_DESKTOP_DIR/troupe.desktop")" = "[Desktop Entry]
Type=Application
Name=Troupe
Exec=$TERMUL_INSTALL_BIN_DIR/troupe
Terminal=false
Categories=Development;Utility;" ]
  [[ "$output" == *"Installed Troupe to $TERMUL_INSTALL_BIN_DIR/troupe"* ]]
  [[ "$output" == *"Warning: $TERMUL_INSTALL_BIN_DIR is not in PATH. Add it to run troupe from your shell."* ]]
}

@test "install_linux keeps the termul-manager names as links to troupe and a hidden desktop entry" {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install

  run install_linux "v1.2.3" "x86_64" "$fixture_sums"

  [ "$status" -eq 0 ]
  [ "$(readlink "$TERMUL_INSTALL_BIN_DIR/termul-manager")" = "troupe" ]
  [ "$(readlink "$TERMUL_INSTALL_BIN_DIR/termul-manager.AppImage")" = "troupe.AppImage" ]
  [ "$(cat "$TERMUL_INSTALL_DESKTOP_DIR/termul-manager.desktop")" = "[Desktop Entry]
Type=Application
Name=Troupe
Exec=$TERMUL_INSTALL_BIN_DIR/troupe
Terminal=false
NoDisplay=true
Categories=Development;Utility;" ]
}

@test "install_linux over a pre-0.5.0 script install leaves both names launching Troupe" {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install
  mkdir -p "$TERMUL_INSTALL_BIN_DIR" "$TERMUL_INSTALL_DESKTOP_DIR"
  printf '#!/usr/bin/env bash\nexec "${BASH_SOURCE[0]%%/*}/termul-manager.AppImage" "$@"\n' >"$TERMUL_INSTALL_BIN_DIR/termul-manager"
  printf '#!/usr/bin/env bash\necho old payload\n' >"$TERMUL_INSTALL_BIN_DIR/termul-manager.AppImage"
  chmod 755 "$TERMUL_INSTALL_BIN_DIR/termul-manager" "$TERMUL_INSTALL_BIN_DIR/termul-manager.AppImage"
  printf '[Desktop Entry]\nName=Termul Manager\nExec=%s/termul-manager\n' "$TERMUL_INSTALL_BIN_DIR" >"$TERMUL_INSTALL_DESKTOP_DIR/termul-manager.desktop"

  run install_linux "v1.2.3" "x86_64" "$fixture_sums"
  [ "$status" -eq 0 ]
  printf '#!/usr/bin/env bash\necho "troupe payload $*"\n' >"$TERMUL_INSTALL_BIN_DIR/troupe.AppImage"

  run --separate-stderr env -u WAYLAND_DISPLAY "$TERMUL_INSTALL_BIN_DIR/troupe" --a
  [ "$status" -eq 0 ]
  [ "$output" = "troupe payload --a" ]
  run --separate-stderr env -u WAYLAND_DISPLAY "$TERMUL_INSTALL_BIN_DIR/termul-manager" --b
  [ "$status" -eq 0 ]
  [ "$output" = "troupe payload --b" ]
  run --separate-stderr env -u WAYLAND_DISPLAY "$TERMUL_INSTALL_BIN_DIR/termul-manager.AppImage" --c
  [ "$status" -eq 0 ]
  [ "$output" = "troupe payload --c" ]
  grep -Fxq "Exec=$TERMUL_INSTALL_BIN_DIR/troupe" "$TERMUL_INSTALL_DESKTOP_DIR/termul-manager.desktop"
  grep -Fxq "NoDisplay=true" "$TERMUL_INSTALL_DESKTOP_DIR/termul-manager.desktop"
}

# Installs for real, then swaps the AppImage for a stub that prints the env and
# argv the launcher hands it.
install_linux_launcher() {
  stub_common_tools
  stub_curl_release_flow "linux appimage payload"
  load_install
  install_linux "v1.2.3" "x86_64" "$fixture_sums" >/dev/null 2>&1
  cat >"$TERMUL_INSTALL_BIN_DIR/troupe.AppImage" <<'STUB'
#!/usr/bin/env bash
printf 'LD_PRELOAD=<%s> marker=<%s> args=<%s>\n' "${LD_PRELOAD-unset}" "${TERMUL_LAUNCHER_PRELOAD-unset}" "$*"
STUB
  chmod 755 "$TERMUL_INSTALL_BIN_DIR/troupe.AppImage"
  wayland_lib="$TERMUL_TEST_TMP_DIR/host/libwayland-client.so.0"
  mkdir -p "${wayland_lib%/*}"
    printf '\177ELF\002' >"$wayland_lib"
}

# ld.so warns on stderr about the fake preload paths; assert on stdout only.
run_launcher() {
  run --separate-stderr env -u LD_PRELOAD -u TERMUL_LAUNCHER_PRELOAD -u WAYLAND_DISPLAY \
    TERMUL_WAYLAND_CLIENT_LIB="$wayland_lib" "$@" "$TERMUL_INSTALL_BIN_DIR/${launcher:-troupe}" --flag "two words"
}

@test "linux launcher preloads the host libwayland on Wayland and records it" {
  install_linux_launcher

  run_launcher WAYLAND_DISPLAY=wayland-0

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<$wayland_lib> marker=<$wayland_lib> args=<--flag two words>" ]
}

@test "linux launcher preloads the same way when started as termul-manager" {
  install_linux_launcher

  launcher=termul-manager run_launcher WAYLAND_DISPLAY=wayland-0

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<$wayland_lib> marker=<$wayland_lib> args=<--flag two words>" ]
}

@test "linux launcher appends to a user LD_PRELOAD and keeps it" {
  install_linux_launcher

  run_launcher WAYLAND_DISPLAY=wayland-0 LD_PRELOAD="/opt/a.so /opt/b.so"

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=</opt/a.so /opt/b.so:$wayland_lib> marker=<$wayland_lib> args=<--flag two words>" ]
}

@test "linux launcher adds nothing when the user already preloads the host libwayland" {
  install_linux_launcher

  run_launcher WAYLAND_DISPLAY=wayland-0 LD_PRELOAD="$wayland_lib"

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<$wayland_lib> marker=<unset> args=<--flag two words>" ]
}

@test "linux launcher leaves X11 sessions untouched" {
  install_linux_launcher

  run_launcher LD_PRELOAD=/opt/a.so

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=</opt/a.so> marker=<unset> args=<--flag two words>" ]
}

@test "linux launcher adds nothing when the host has no libwayland" {
  install_linux_launcher
  rm "$wayland_lib"

  run_launcher WAYLAND_DISPLAY=wayland-0 TERMUL_LAUNCHER_PRELOAD=/stale.so

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<unset> marker=<unset> args=<--flag two words>" ]
}

@test "linux launcher skips a 32-bit libwayland and says so" {
  install_linux_launcher
  printf '\177ELF\001' >"$wayland_lib"

  run_launcher WAYLAND_DISPLAY=wayland-0

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<unset> marker=<unset> args=<--flag two words>" ]
  [[ "$stderr" == *"TERMUL_WAYLAND_CLIENT_LIB=$wayland_lib is not a 64-bit library"* ]]
}

@test "linux launcher prefers TROUPE_WAYLAND_CLIENT_LIB" {
  install_linux_launcher
  troupe_lib="$TERMUL_TEST_TMP_DIR/troupe/libwayland-client.so.0"
  mkdir -p "${troupe_lib%/*}"
  printf '\177ELF\002' >"$troupe_lib"

  run_launcher WAYLAND_DISPLAY=wayland-0 TROUPE_WAYLAND_CLIENT_LIB="$troupe_lib"

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<$troupe_lib> marker=<$troupe_lib> args=<--flag two words>" ]
}

@test "linux launcher finds the AppImage when started through a symlink" {
  install_linux_launcher
  mkdir -p "$TERMUL_TEST_TMP_DIR/elsewhere"
  ln -s "$TERMUL_INSTALL_BIN_DIR/troupe" "$TERMUL_TEST_TMP_DIR/elsewhere/termul"

  run --separate-stderr env -u LD_PRELOAD -u WAYLAND_DISPLAY "$TERMUL_TEST_TMP_DIR/elsewhere/termul" --flag

  [ "$status" -eq 0 ]
  [ "$output" = "LD_PRELOAD=<unset> marker=<unset> args=<--flag>" ]
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
  [[ "$output" == *"Install Troupe v1.2.3 (darwin-aarch64) to $TERMUL_INSTALL_APPLICATIONS_DIR?"* ]]
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
  [[ "$output" == *"Install Troupe v1.2.3 (linux-x86_64) to $HOME/.local/bin?"* ]]
  [ -x "$TERMUL_INSTALL_BIN_DIR/troupe" ]
  grep -q "Troupe_1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
  ! grep -q "Troupe_v1.2.3_amd64.AppImage" "$TERMUL_TEST_LOG"
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
  [[ "$output" == *"Integrity check failed, nothing was installed"* ]]
  ! grep -q "hdiutil" "$TERMUL_TEST_LOG"
  ! grep -q "^cp " "$TERMUL_TEST_LOG"
  ! grep -q "xattr" "$TERMUL_TEST_LOG"
}

@test "piping the script to bash runs main without an unbound BASH_SOURCE error" {
  stub_uname Plan9 x86_64

  run bash -c 'cat "$1" | bash' _ "$TERMUL_TEST_REPO_ROOT/scripts/install.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported operating system"* ]]
  [[ "$output" != *"unbound variable"* ]]
}

@test "executing the script directly runs main" {
  stub_uname Plan9 x86_64

  run bash "$TERMUL_TEST_REPO_ROOT/scripts/install.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported operating system"* ]]
}

@test "sourcing the script does not run main" {
  stub_uname Plan9 x86_64

  run bash -c 'source "$1"; declare -F main >/dev/null && echo defined' _ "$TERMUL_TEST_REPO_ROOT/scripts/install.sh"

  [ "$status" -eq 0 ]
  [ "$output" = "defined" ]
}
