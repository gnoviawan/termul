#!/usr/bin/env bash

normalize_release_version() {
  local version="${1#v}"
  local core prerelease identifier
  local semver='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

  if [[ ! "$version" =~ $semver ]]; then
    echo "Invalid SemVer release version: $version" >&2
    return 1
  fi

  core="${version%%[-+]*}"
  while IFS= read -r identifier; do
    if [[ "$identifier" != "0" && "$identifier" == 0* ]]; then
      echo "Invalid SemVer release version: $version" >&2
      return 1
    fi
  done < <(printf '%s\n' "$core" | tr '.' '\n')

  prerelease="${version%%+*}"
  if [[ "$prerelease" == *-* ]]; then
    prerelease="${prerelease#*-}"
    while IFS= read -r identifier; do
      if [[ "$identifier" =~ ^[0-9]+$ && "$identifier" != "0" && "$identifier" == 0* ]]; then
        echo "Invalid SemVer release version: $version" >&2
        return 1
      fi
    done < <(printf '%s\n' "$prerelease" | tr '.' '\n')
  fi

  printf '%s\n' "$version"
}

is_release_prerelease() {
  local version
  version="$(normalize_release_version "$1")" || return 1
  version="${version%%+*}"
  [[ "$version" == *-* ]]
}

resolve_dmg_checksums() {
  local checksum_file="$1"
  local version="$2"
  local arm_dmg="Termul.Manager_${version}_aarch64.dmg"
  local intel_dmg="Termul.Manager_${version}_x64.dmg"
  local arm_sha256 intel_sha256

  arm_sha256="$(awk -v file="$arm_dmg" '$2 == file || $2 == "*" file { print $1 }' "$checksum_file")"
  intel_sha256="$(awk -v file="$intel_dmg" '$2 == file || $2 == "*" file { print $1 }' "$checksum_file")"

  if [[ "$(printf '%s\n' "$arm_sha256" | sed '/^$/d' | wc -l)" -ne 1 || ! "$arm_sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Missing, duplicate, or invalid checksum for $arm_dmg" >&2
    return 1
  fi

  if [[ "$(printf '%s\n' "$intel_sha256" | sed '/^$/d' | wc -l)" -ne 1 || ! "$intel_sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Missing, duplicate, or invalid checksum for $intel_dmg" >&2
    return 1
  fi

  printf '%s\n%s\n' "$arm_sha256" "$intel_sha256"
}

# Generate SHA256SUMS.txt for downloaded release assets, validating that
# every checksummed filename exactly matches a published release asset
# name. `scripts/install.sh` resolves checksums by exact asset name, so a
# silent name mismatch (e.g. a file named with the product display name
# "Termul Manager" while the release asset is "Termul.Manager") makes the
# install fail with "checksum not found" even though the asset itself
# downloaded fine (#546).
#
#   generate_sha256sums <asset_dir> <expected_names_file> <output_file>
#
# <expected_names_file> lists the release's published asset names, one per
# line (e.g. `gh release view --json assets --jq '.assets[].name'`).
# Signatures and the updater manifest are not installable assets and are
# skipped, mirroring the previous inline workflow logic.
generate_sha256sums() {
  local asset_dir="$1"
  local expected_names_file="$2"
  local output_file="$3"

  if [[ ! -d "$asset_dir" ]]; then
    echo "Asset directory not found: $asset_dir" >&2
    return 1
  fi
  if [[ ! -s "$expected_names_file" ]]; then
    echo "Expected release asset names file is missing or empty: $expected_names_file" >&2
    return 1
  fi

  local asset name asset_count=0 tmp_output
  # Write to a sibling temp file and move it into place only after every
  # asset validates: a mid-loop failure must not leave partial output or
  # clobber a previously published checksum file.
  tmp_output="$(mktemp "${output_file}.tmp.XXXXXX")" || return 1
  while IFS= read -r -d '' asset; do
    name="$(basename "$asset")"
    case "$name" in
      *.sig|latest.json|SHA256SUMS.txt) continue ;;
    esac
    if ! grep -Fxq -- "$name" "$expected_names_file"; then
      echo "Refusing to checksum '$name': it is not a published release asset name." >&2
      echo "scripts/install.sh resolves checksums by exact asset name; a name mismatch breaks the install (#546)." >&2
      rm -f -- "$tmp_output"
      return 1
    fi
    # Checksum from inside the directory so the entry carries the bare
    # asset name, exactly like the installer looks it up.
    if ! (cd "$asset_dir" && sha256sum "$name") >> "$tmp_output"; then
      rm -f -- "$tmp_output"
      return 1
    fi
    asset_count=$((asset_count + 1))
  done < <(find "$asset_dir" -maxdepth 1 -type f -print0 | sort -z)

  if [[ "$asset_count" -eq 0 ]]; then
    echo "No binary release assets found to checksum." >&2
    rm -f -- "$tmp_output"
    return 1
  fi

  mv -- "$tmp_output" "$output_file"
}

write_homebrew_cask() {
  local output_file="$1"
  local version="$2"
  local arm_sha256="$3"
  local intel_sha256="$4"

  mkdir -p "$(dirname "$output_file")"
  cat >"$output_file" <<EOF
cask "termul" do
  arch arm: "aarch64", intel: "x64"

  version "$version"
  sha256 arm:   "$arm_sha256",
         intel: "$intel_sha256"

  url "https://github.com/gnoviawan/termul/releases/download/v#{version}/Termul.Manager_#{version}_#{arch}.dmg"
  name "Termul Manager"
  desc "Terminal-native workspace and CLI agent manager"
  homepage "https://github.com/gnoviawan/termul"

  auto_updates true
  depends_on macos: :catalina

  app "Termul Manager.app"
EOF

  if [[ "$version" == "0.4.8" ]]; then
    cat >>"$output_file" <<'EOF'

  # v0.4.8 predates Developer ID signing and notarization. Do not copy this
  # narrowly scoped compatibility exception to later casks.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Termul Manager.app"]
  end
EOF
  fi

  cat >>"$output_file" <<'EOF'

  zap trash: [
    "~/Library/Application Support/com.termul-manager.app",
    "~/Library/Caches/com.termul-manager.app",
    "~/Library/HTTPStorages/com.termul-manager.app",
    "~/Library/Logs/com.termul-manager.app",
    "~/Library/Preferences/com.termul-manager.app.plist",
    "~/Library/Saved Application State/com.termul-manager.app.savedState",
    "~/Library/WebKit/com.termul-manager.app",
  ]
end
EOF
}
