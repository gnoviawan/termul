#!/usr/bin/env bash

# 0.5.0 renamed the release assets from Termul.Manager_* to Troupe_*. The
# v0.4.60 scripts/install.sh is pinned in the docs and copied around the web,
# and it installs whatever release is latest. It downloads
# Termul.Manager_<version>_<arch>.dmg or Termul.Manager_<version>_amd64.AppImage,
# looks that exact name up in SHA256SUMS.txt (which checksums every published
# asset), and copies "Termul Manager.app" out of the DMG. So a 0.5.x release
# also ships those names: the AppImage byte for byte, and a DMG holding the
# same signed app under the old bundle name.

LEGACY_INSTALL_ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/homebrew.sh
source "${LEGACY_INSTALL_ASSETS_DIR}/homebrew.sh"

# add_legacy_install_assets <platform> <version> <assets_dir> [<app_bundle>]
#
# Writes the legacy-named asset for <platform> into <assets_dir> and prints its
# path. <app_bundle> is the signed .app, required for macos-* platforms.
# Releases before 0.5.0 already carry the legacy names, and the v0.4.60 script
# refuses Windows, so those print nothing.
add_legacy_install_assets() {
  local platform="$1"
  local version="$2"
  local assets_dir="$3"
  local app_bundle="${4:-}"
  local name

  version="$(normalize_release_version "$version")" || return 1
  name="$(release_product_name "$version")" || return 1
  if [[ "$name" == "Termul Manager" ]]; then
    return 0
  fi

  case "$platform" in
    linux-x64)
      local source_asset="${assets_dir}/Troupe_${version}_amd64.AppImage"
      local legacy_asset="${assets_dir}/Termul.Manager_${version}_amd64.AppImage"
      if [[ ! -s "$source_asset" ]]; then
        echo "Missing ${source_asset}; cannot add the AppImage name the v0.4.60 install.sh downloads." >&2
        return 1
      fi
      cp "$source_asset" "$legacy_asset" || return 1
      printf '%s\n' "$legacy_asset"
      ;;
    macos-aarch64 | macos-x64)
      local suffix="${platform#macos-}"
      local legacy_asset="${assets_dir}/Termul.Manager_${version}_${suffix}.dmg"
      build_legacy_dmg "$app_bundle" "$legacy_asset" || return 1
      printf '%s\n' "$legacy_asset"
      ;;
    windows-x64) ;;
    *)
      echo "Unsupported platform: ${platform}" >&2
      return 1
      ;;
  esac
}

# build_legacy_dmg <app_bundle> <output_dmg>
#
# Packs <app_bundle> as "Termul Manager.app" at the DMG root. Renaming the
# bundle directory keeps its code signature and stapled ticket valid.
build_legacy_dmg() {
  local app_bundle="$1"
  local output_dmg="$2"
  local staging attempt

  if [[ ! -d "$app_bundle" || "$app_bundle" != *.app ]]; then
    echo "Expected a signed .app bundle for the legacy DMG, got: ${app_bundle:-nothing}" >&2
    return 1
  fi

  staging="$(mktemp -d)" || return 1
  if ! ditto "$app_bundle" "${staging}/Termul Manager.app"; then
    rm -rf "$staging"
    return 1
  fi

  # hdiutil create sometimes fails with "Resource busy" on hosted macOS
  # runners; the retry clears it.
  for attempt in 1 2 3; do
    if hdiutil create -volname "Termul Manager" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$output_dmg" >&2; then
      rm -rf "$staging"
      return 0
    fi
    sleep "$((attempt * 5))"
  done
  rm -rf "$staging"
  echo "hdiutil create failed for ${output_dmg}" >&2
  return 1
}
