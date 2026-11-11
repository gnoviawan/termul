#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

load "helpers.bash"

legacy_install_sh="$TERMUL_TEST_REPO_ROOT/scripts/tests/fixtures/install-v0.4.60.sh"

setup() {
  make_tmp
  export TERMUL_TEST_LOG="$TERMUL_TEST_TMP_DIR/commands.log"
  : >"$TERMUL_TEST_LOG"
  ASSETS="$TERMUL_TEST_TMP_DIR/assets"
  APP="$TERMUL_TEST_TMP_DIR/bundle/macos/Troupe.app"
  mkdir -p "$ASSETS" "$APP/Contents/MacOS"
  printf '#!/usr/bin/env bash\necho "payload Troupe 0.5.0 $*"\n' >"$ASSETS/Troupe_0.5.0_amd64.AppImage"
  printf 'troupe dmg aarch64' >"$ASSETS/Troupe_0.5.0_aarch64.dmg"
  printf 'troupe dmg x64' >"$ASSETS/Troupe_0.5.0_x64.dmg"
  printf 'signed troupe binary' >"$APP/Contents/MacOS/troupe"
  stub_dmg_tools
  source "$TERMUL_TEST_REPO_ROOT/scripts/release/legacy-install-assets.sh"
}

teardown() {
  cleanup_tmp
}

# A DMG is a tar of the -srcfolder contents; attach unpacks it at the mountpoint,
# so the v0.4.60 installer sees exactly what create packed.
stub_dmg_tools() {
  stub_cmd ditto "printf 'ditto %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"; cp -R \"\$1\" \"\$2\""
  stub_cmd hdiutil "
printf 'hdiutil %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
prev=''; src=''; mnt=''
for arg in \"\$@\"; do
  [[ \"\$prev\" == -srcfolder ]] && src=\"\$arg\"
  [[ \"\$prev\" == -mountpoint ]] && mnt=\"\$arg\"
  prev=\"\$arg\"
done
case \"\$1\" in
  create) tar -C \"\$src\" -cf \"\${@: -1}\" . ;;
  attach) tar -C \"\$mnt\" -xf \"\${@: -1}\" ;;
esac
"
  stub_cmd xattr "printf 'xattr %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\""
}

# Publishes ASSETS as release v0.5.0 with the SHA256SUMS.txt the release
# workflow writes, and serves it to curl like github.com does.
publish_release() {
  local release="$TERMUL_TEST_TMP_DIR/release"
  mkdir -p "$release"
  cp "$ASSETS"/* "$release/"
  (cd "$release" && ls -1) >"$TERMUL_TEST_TMP_DIR/release-asset-names.txt"
  generate_sha256sums "$release" "$TERMUL_TEST_TMP_DIR/release-asset-names.txt" "$TERMUL_TEST_TMP_DIR/SHA256SUMS.txt"
  cp "$TERMUL_TEST_TMP_DIR/SHA256SUMS.txt" "$release/"
  stub_cmd curl "
printf 'curl %s\\n' \"\$*\" >>\"\$TERMUL_TEST_LOG\"
prev=''; out=''; url=''
for arg in \"\$@\"; do
  [[ \"\$prev\" == -o ]] && out=\"\$arg\"
  [[ \"\$arg\" == https://* ]] && url=\"\$arg\"
  prev=\"\$arg\"
done
case \"\$url\" in
  https://github.com/gnoviawan/termul/releases/latest)
    printf 'https://github.com/gnoviawan/termul/releases/tag/v0.5.0' ;;
  https://github.com/gnoviawan/termul/releases/download/v0.5.0/*)
    src='$release'/\"\${url##*/}\"
    [[ -f \"\$src\" ]] || { echo \"curl: (22) 404 \$url\" >&2; exit 22; }
    cp \"\$src\" \"\$out\" ;;
  *) echo \"curl: (6) unexpected \$url\" >&2; exit 6 ;;
esac
"
}

run_legacy_installer() {
  local os="$1"
  local arch="$2"
  mkdir -p "$TERMUL_TEST_TMP_DIR/Applications"
  stub_cmd uname "case \"\$1\" in -s) echo '$os' ;; -m) echo '$arch' ;; esac"
  HOME="$TERMUL_TEST_TMP_DIR/home" \
    TERMUL_INSTALL_YES=1 \
    TERMUL_INSTALL_APPLICATIONS_DIR="$TERMUL_TEST_TMP_DIR/Applications" \
    TERMUL_INSTALL_BIN_DIR="$TERMUL_TEST_TMP_DIR/home/.local/bin" \
    TERMUL_INSTALL_DESKTOP_DIR="$TERMUL_TEST_TMP_DIR/home/.local/share/applications" \
    run bash "$legacy_install_sh"
}

@test "linux 0.5.0 adds a byte-identical Termul.Manager AppImage" {
  run add_legacy_install_assets linux-x64 0.5.0 "$ASSETS"

  [ "$status" -eq 0 ]
  [ "$output" = "$ASSETS/Termul.Manager_0.5.0_amd64.AppImage" ]
  cmp "$ASSETS/Troupe_0.5.0_amd64.AppImage" "$ASSETS/Termul.Manager_0.5.0_amd64.AppImage"
}

@test "macOS 0.5.0 packs the signed app as Termul Manager.app in a Termul.Manager DMG" {
  run add_legacy_install_assets macos-aarch64 v0.5.0-rc.1 "$ASSETS" "$APP"

  [ "$status" -eq 0 ]
  [ "$output" = "$ASSETS/Termul.Manager_0.5.0-rc.1_aarch64.dmg" ]
  [ "$(tar -tf "$output" | grep -c 'Termul Manager.app/Contents/MacOS/troupe$')" -eq 1 ]
  ! tar -tf "$output" | grep -q 'Troupe.app'
  grep -q 'hdiutil create -volname Termul Manager' "$TERMUL_TEST_LOG"
}

@test "macOS without an app bundle fails before running hdiutil" {
  run add_legacy_install_assets macos-x64 0.5.0 "$ASSETS" ""

  [ "$status" -ne 0 ]
  [[ "$output" == *"Expected a signed .app bundle"* ]]
  ! grep -q hdiutil "$TERMUL_TEST_LOG"
}

@test "linux without the Troupe AppImage fails and names it" {
  rm "$ASSETS/Troupe_0.5.0_amd64.AppImage"

  run add_legacy_install_assets linux-x64 0.5.0 "$ASSETS"

  [ "$status" -ne 0 ]
  [[ "$output" == *"Missing $ASSETS/Troupe_0.5.0_amd64.AppImage"* ]]
}

@test "releases before 0.5.0 and Windows add nothing" {
  run add_legacy_install_assets linux-x64 0.4.61 "$ASSETS"
  [ "$status" -eq 0 ]
  [ "$output" = "" ]

  run add_legacy_install_assets windows-x64 0.5.0 "$ASSETS"
  [ "$status" -eq 0 ]
  [ "$output" = "" ]

  [ "$(ls "$ASSETS" | grep -c Termul)" -eq 0 ]
}

@test "the v0.4.60 install.sh cannot install a 0.5.0 release that lacks the legacy names" {
  publish_release

  run_legacy_installer Linux x86_64

  [ "$status" -ne 0 ]
  [[ "$output" == *"404 https://github.com/gnoviawan/termul/releases/download/v0.5.0/Termul.Manager_0.5.0_amd64.AppImage"* ]]
}

@test "the v0.4.60 install.sh installs 0.5.0 on Linux from the legacy AppImage" {
  add_legacy_install_assets linux-x64 0.5.0 "$ASSETS" >/dev/null
  publish_release

  run_legacy_installer Linux x86_64

  [ "$status" -eq 0 ]
  [[ "$output" == *"Installed Termul Manager to $TERMUL_TEST_TMP_DIR/home/.local/bin/termul-manager"* ]]
  run "$TERMUL_TEST_TMP_DIR/home/.local/bin/termul-manager" --version
  [ "$output" = "payload Troupe 0.5.0 --version" ]
}

@test "the v0.4.60 install.sh installs 0.5.0 on macOS from the legacy DMG" {
  add_legacy_install_assets macos-aarch64 0.5.0 "$ASSETS" "$APP" >/dev/null
  add_legacy_install_assets macos-x64 0.5.0 "$ASSETS" "$APP" >/dev/null
  publish_release

  run_legacy_installer Darwin arm64

  [ "$status" -eq 0 ]
  [[ "$output" == *"Installed Termul Manager to $TERMUL_TEST_TMP_DIR/Applications/Termul Manager.app"* ]]
  [ "$(cat "$TERMUL_TEST_TMP_DIR/Applications/Termul Manager.app/Contents/MacOS/troupe")" = "signed troupe binary" ]
  grep -q 'releases/download/v0.5.0/Termul.Manager_0.5.0_aarch64.dmg' "$TERMUL_TEST_LOG"
}
