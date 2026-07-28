#!/usr/bin/env bats

load "helpers.bash"

setup() {
  make_tmp
  source "$TERMUL_TEST_REPO_ROOT/scripts/release/homebrew.sh"
}

teardown() {
  cleanup_tmp
}

@test "normalizes full SemVer tags with dotted prerelease and build identifiers" {
  run normalize_release_version "v1.2.3-beta.1"
  [ "$status" -eq 0 ]
  [ "$output" = "1.2.3-beta.1" ]

  run normalize_release_version "1.2.3-beta.1+macos.7"
  [ "$status" -eq 0 ]
  [ "$output" = "1.2.3-beta.1+macos.7" ]

  run normalize_release_version "1.2.3+signed-macos.7"
  [ "$status" -eq 0 ]
  [ "$output" = "1.2.3+signed-macos.7" ]
}

@test "rejects incomplete unsafe and leading-zero versions" {
  for invalid in \
    "1.2" \
    "1.2.3/../../tap" \
    "01.2.3" \
    "1.02.3" \
    "1.2.03" \
    "1.2.3-01" \
    "1.2.3-beta.01"; do
    run normalize_release_version "$invalid"
    [ "$status" -ne 0 ]
  done
}

@test "classifies prerelease before build metadata only" {
  run is_release_prerelease "1.2.3-beta.1+signed-macos.7"
  [ "$status" -eq 0 ]

  run is_release_prerelease "1.2.3+signed-macos.7"
  [ "$status" -ne 0 ]
}

@test "resolves exact DMG checksums" {
  local checksums="$TERMUL_TEST_TMP_DIR/SHA256SUMS.txt"
  local arm_sha="$(printf 'a%.0s' {1..64})"
  local intel_sha="$(printf 'b%.0s' {1..64})"
  cat >"$checksums" <<EOF
$arm_sha  Termul.Manager_0.4.8_aarch64.dmg
$intel_sha *Termul.Manager_0.4.8_x64.dmg
EOF

  run resolve_dmg_checksums "$checksums" "0.4.8"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "$arm_sha" ]
  [ "${lines[1]}" = "$intel_sha" ]
}

@test "checksum resolution propagates missing malformed and duplicate errors" {
  local checksums="$TERMUL_TEST_TMP_DIR/SHA256SUMS.txt"
  local arm_sha="$(printf 'a%.0s' {1..64})"
  local intel_sha="$(printf 'b%.0s' {1..64})"

  printf '%s  %s\n' "$arm_sha" "Termul.Manager_0.4.8_aarch64.dmg" >"$checksums"
  run resolve_dmg_checksums "$checksums" "0.4.8"
  [ "$status" -ne 0 ]
  [[ "$output" == *"x64.dmg"* ]]

  cat >"$checksums" <<EOF
not-a-hash  Termul.Manager_0.4.8_aarch64.dmg
$intel_sha  Termul.Manager_0.4.8_x64.dmg
EOF
  run resolve_dmg_checksums "$checksums" "0.4.8"
  [ "$status" -ne 0 ]
  [[ "$output" == *"aarch64.dmg"* ]]

  cat >"$checksums" <<EOF
$arm_sha  Termul.Manager_0.4.8_aarch64.dmg
$arm_sha  Termul.Manager_0.4.8_aarch64.dmg
$intel_sha  Termul.Manager_0.4.8_x64.dmg
EOF
  run resolve_dmg_checksums "$checksums" "0.4.8"
  [ "$status" -ne 0 ]
  [[ "$output" == *"aarch64.dmg"* ]]
}

@test "generates the exact v0.4.8 xattr exception and omits it for future releases" {
  local legacy="$TERMUL_TEST_TMP_DIR/termul-0.4.8.rb"
  local future="$TERMUL_TEST_TMP_DIR/termul-0.4.9.rb"
  local arm_sha="6be298c2c2c8562b340b069357e8b5d6c3838791ac77c089114004db6a663e69"
  local intel_sha="72b1d5ab617dcc72c021ec4524ec90a8607870d2011fa83686c4ccda185854c8"

  write_homebrew_cask "$legacy" "0.4.8" "$arm_sha" "$intel_sha"
  [ "$(grep -Fc 'com.apple.quarantine' "$legacy")" -eq 1 ]
  grep -Fq 'args: ["-dr", "com.apple.quarantine", "#{appdir}/Termul Manager.app"]' "$legacy"

  write_homebrew_cask "$future" "0.4.9" "$arm_sha" "$intel_sha"
  ! grep -Fq 'com.apple.quarantine' "$future"
}

@test "prerelease metadata path does not require a Homebrew token" {
  local workflow="$TERMUL_TEST_REPO_ROOT/.github/workflows/publish-homebrew.yml"
  grep -Fq "if: needs.release_metadata.outputs.is_prerelease == 'false'" "$workflow"
  ! sed -n '/release_metadata:/,/checksums:/p' "$workflow" | grep -q 'HOMEBREW_TAP_TOKEN'
  ! sed -n '/checksums:/,/homebrew:/p' "$workflow" | grep -q 'HOMEBREW_TAP_TOKEN'
}

@test "release workflows preserve permissions token flow portability and tap serialization" {
  local release_workflow="$TERMUL_TEST_REPO_ROOT/.github/workflows/release.yml"
  local homebrew_workflow="$TERMUL_TEST_REPO_ROOT/.github/workflows/publish-homebrew.yml"

  grep -Fq 'group: publish-homebrew-tap' "$homebrew_workflow"
  grep -Fq 'GH_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}' "$homebrew_workflow"
  grep -Fq 'contents: write' "${release_workflow}"
  grep -Fq 'source scripts/release/homebrew.sh' "$release_workflow"
  grep -Fq 'otool -L "$executable"' "$release_workflow"
  grep -Fq 'LC_RPATH' "$release_workflow"
  ! sed -n '/Verify macOS bundle library portability and signing/,/Collect platform release assets/p' "$release_workflow" | grep -q 'mapfile'
}
