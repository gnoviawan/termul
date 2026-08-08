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
