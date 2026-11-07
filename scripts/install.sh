#!/usr/bin/env bash
set -euo pipefail

OWNER="gnoviawan"
REPO="termul"
BASE_URL="https://github.com/${OWNER}/${REPO}"

die() {
  printf '%s\n' "$*" >&2
  return 1
}

# Settings read from the environment. TROUPE_<name> wins; the old
# TERMUL_<name> still works.
INSTALL_ENV_NAMES=(INSTALL_YES INSTALL_APPLICATIONS_DIR INSTALL_BIN_DIR INSTALL_DESKTOP_DIR)

brand_env() {
  local new="TROUPE_$1"
  local old="TERMUL_$1"

  local value="${!new:-}"

  if [[ -n "${value//[[:space:]]/}" ]]; then
    printf '%s' "$value"
  else
    printf '%s' "${!old:-}"
  fi
}

note_legacy_env() {
  local name
  local new
  local old
  local value

  for name in "${INSTALL_ENV_NAMES[@]}"; do
    new="TROUPE_${name}"
    old="TERMUL_${name}"
    value="${!new:-}"
    if [[ -z "${value//[[:space:]]/}" && -n "${!old:-}" ]]; then
      printf '%s is deprecated; rename it to %s (%s still works for now)\n' "$old" "$new" "$old" >&2
    fi
  done
}

detect_os() {
  local os
  os="$(uname -s)"

  case "$os" in
    Darwin)
      printf '%s\n' "darwin"
      ;;
    Linux)
      printf '%s\n' "linux"
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "Windows is not supported by the curl installer. Download the .exe or .msi from ${BASE_URL}/releases."
      ;;
    *)
      die "Unsupported operating system: ${os}"
      ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"

  case "$arch" in
    arm64 | aarch64)
      printf '%s\n' "aarch64"
      ;;
    x86_64 | amd64)
      printf '%s\n' "x86_64"
      ;;
    *)
      die "Unsupported architecture: ${arch}"
      ;;
  esac
}

require_tools() {
  local os="${1:-}"
  local missing=()
  local tool
  local common_tools=(curl mktemp awk)

  for tool in "${common_tools[@]}"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing+=("$tool")
    fi
  done

  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    missing+=("sha256sum or shasum")
  fi

  case "$os" in
    darwin)
      for tool in hdiutil cp xattr; do
        if ! command -v "$tool" >/dev/null 2>&1; then
          missing+=("$tool")
        fi
      done
      ;;
    linux)
      for tool in cp chmod mkdir od tr; do
        if ! command -v "$tool" >/dev/null 2>&1; then
          missing+=("$tool")
        fi
      done
      ;;
  esac

  if ((${#missing[@]} > 0)); then
    printf 'Missing required tools:' >&2
    printf ' %s' "${missing[@]}" >&2
    printf '\n' >&2
    return 1
  fi
}

resolve_version() {
  local effective_url
  local version

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
  local output="${2:-}"

  if [[ -z "$output" ]]; then
    output="$(mktemp)"
  fi

  curl -fsSL "${BASE_URL}/releases/download/${version}/SHA256SUMS.txt" -o "$output"
  printf '%s\n' "$output"
}

asset_version() {
  local version="$1"

  printf '%s\n' "${version#v}"
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

  expected="$(awk -v asset="$asset_name" '$2 == asset { print $1; found = 1; exit } END { if (!found) exit 1 }' "$sums_file")" || {
    die "Integrity check failed, nothing was installed: checksum for ${asset_name} not found"
    return 1
  }

  actual="$(hash_file "$file")"
  if [[ "$actual" != "$expected" ]]; then
    die "Integrity check failed, nothing was installed: checksum for ${asset_name} did not match"
    return 1
  fi
}

confirm_install() {
  local prompt="$1"
  local reply

  if [[ "$(brand_env INSTALL_YES)" == "1" ]]; then
    printf 'TROUPE_INSTALL_YES=1: %s\n' "$prompt"
    return 0
  fi

  if [[ ! -r /dev/tty ]]; then
    die "Interactive confirmation requires /dev/tty. Set TROUPE_INSTALL_YES=1 to install non-interactively."
    return 1
  fi

  printf '%s [y/N] ' "$prompt" >/dev/tty
  if ! IFS= read -r reply </dev/tty; then
    die "Interactive confirmation requires /dev/tty. Set TROUPE_INSTALL_YES=1 to install non-interactively."
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

download_asset() {
  local version="$1"
  local asset_name="$2"
  local output="$3"

  curl -fL "${BASE_URL}/releases/download/${version}/${asset_name}" -o "$output"
}

install_macos() {
  local version="$1"
  local arch="${2:-$(detect_arch)}"
  local sums_file="${3:-}"
  local suffix
  local normalized_version
  local asset_name
  local tmpdir
  local dmg_path
  local mount_dir
  local applications_dir
  applications_dir="$(brand_env INSTALL_APPLICATIONS_DIR)"
  applications_dir="${applications_dir:-/Applications}"
  local app_source
  local app_target

  case "$arch" in
    aarch64)
      suffix="aarch64"
      ;;
    x86_64)
      suffix="x64"
      ;;
    *)
      die "Unsupported macOS architecture: ${arch}"
      return 1
      ;;
  esac

  normalized_version="$(asset_version "$version")"
  asset_name="Termul.Manager_${normalized_version}_${suffix}.dmg"
  tmpdir="$(mktemp -d)"
  dmg_path="${tmpdir}/${asset_name}"
  mount_dir="${tmpdir}/mount"
  mkdir -p "$mount_dir"

  (
    set -euo pipefail

    termul_macos_mounted=0
    termul_macos_mount_dir="$mount_dir"
    termul_macos_tmpdir="$tmpdir"
    trap 'if [[ "${termul_macos_mounted:-0}" == "1" ]]; then hdiutil detach "${termul_macos_mount_dir:-}" >/dev/null 2>&1 || true; fi; rm -rf "${termul_macos_tmpdir:-}"' EXIT

    if [[ -z "$sums_file" ]]; then
      sums_file="$(fetch_sha256sums "$version" "${tmpdir}/SHA256SUMS.txt")" || exit 1
    fi

    download_asset "$version" "$asset_name" "$dmg_path" || exit 1
    verify_sha256 "$dmg_path" "$asset_name" "$sums_file" || exit 1

    hdiutil attach -nobrowse -mountpoint "$mount_dir" "$dmg_path" || exit 1
    termul_macos_mounted=1

    app_source="${mount_dir}/Termul Manager.app"
    app_target="${applications_dir}/Termul Manager.app"
    if [[ -e "$app_target" ]]; then
      if ! rm -rf "$app_target"; then
        sudo rm -rf "$app_target" || exit 1
      fi
    fi

    if ! cp -R "$app_source" "$applications_dir/"; then
      sudo cp -R "$app_source" "$applications_dir/" || exit 1
    fi

    hdiutil detach "$mount_dir" || exit 1
    termul_macos_mounted=0
    xattr -dr com.apple.quarantine "$app_target" 2>/dev/null || true
    printf 'Installed Termul Manager to %s\n' "$app_target"
  )
}

install_linux() {
  local version="$1"
  local arch="${2:-$(detect_arch)}"
  local sums_file="${3:-}"
  local normalized_version
  local asset_name
  local tmpdir
  local appimage_path
  local bin_dir
  local desktop_dir
  bin_dir="$(brand_env INSTALL_BIN_DIR)"
  bin_dir="${bin_dir:-${HOME}/.local/bin}"
  desktop_dir="$(brand_env INSTALL_DESKTOP_DIR)"
  desktop_dir="${desktop_dir:-${HOME}/.local/share/applications}"
  local target_path="${bin_dir}/termul-manager"
  local appimage_target="${bin_dir}/termul-manager.AppImage"
  local desktop_path="${desktop_dir}/termul-manager.desktop"

  if [[ "$arch" != "x86_64" ]]; then
    die "Unsupported Linux architecture: ${arch}"
    return 1
  fi

  normalized_version="$(asset_version "$version")"
  asset_name="Termul.Manager_${normalized_version}_amd64.AppImage"
  tmpdir="$(mktemp -d)"
  appimage_path="${tmpdir}/${asset_name}"

  (
    set -euo pipefail

    termul_linux_tmpdir="$tmpdir"
    trap 'rm -rf "${termul_linux_tmpdir:-}"' EXIT

    if [[ -z "$sums_file" ]]; then
      sums_file="$(fetch_sha256sums "$version" "${tmpdir}/SHA256SUMS.txt")" || exit 1
    fi

    download_asset "$version" "$asset_name" "$appimage_path" || exit 1
    verify_sha256 "$appimage_path" "$asset_name" "$sums_file" || exit 1

    mkdir -p "$bin_dir" "$desktop_dir" || exit 1
    cp "$appimage_path" "$appimage_target" || exit 1
    chmod 755 "$appimage_target" || exit 1
    cat >"$target_path" <<'LAUNCHER'
#!/usr/bin/env bash
set -e

# The AppImage bundles a libwayland-client that Mesa 25 and later cannot create
# an EGL display with, which leaves the window blank on Wayland (#1682).
# Preloading the host copy fixes it. TERMUL_LAUNCHER_PRELOAD records the entry
# added here so Termul removes exactly that entry from its terminals.
unset TERMUL_LAUNCHER_PRELOAD
if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  # TROUPE_WAYLAND_CLIENT_LIB wins; the old TERMUL_ name still works.
  _wayland_var=TERMUL_WAYLAND_CLIENT_LIB
  _troupe_lib="${TROUPE_WAYLAND_CLIENT_LIB:-}"
  [[ -z "${_troupe_lib//[[:space:]]/}" ]] || _wayland_var=TROUPE_WAYLAND_CLIENT_LIB
  _wayland_lib="${!_wayland_var:-}"
  if [[ -n "$_wayland_lib" ]]; then
    _candidates=("$_wayland_lib")
  else
    _candidates=(
      /usr/lib64/libwayland-client.so.0
      /usr/lib/x86_64-linux-gnu/libwayland-client.so.0
      /usr/lib/libwayland-client.so.0
    )
  fi
  # Only a 64-bit library (ELF class byte 0x02) can be preloaded into the
  # 64-bit AppImage; ld.so ignores a 32-bit copy and the window stays blank.
  _elf64() { [[ "$(od -An -tx1 -j4 -N1 "$1" 2>/dev/null | tr -d ' \n')" == 02 ]]; }
  for _lib in "${_candidates[@]}"; do
    if [[ ! -f "$_lib" ]] || ! _elf64 "$_lib"; then
      if [[ -n "$_wayland_lib" ]]; then
        echo "termul-manager: ${_wayland_var}=${_lib} is not a 64-bit library; starting without the Wayland preload" >&2
      fi
      continue
    fi
    case " ${LD_PRELOAD//:/ } " in
      *" ${_lib} "*) ;;
      *)
        export LD_PRELOAD="${LD_PRELOAD:+${LD_PRELOAD}:}${_lib}"
        export TERMUL_LAUNCHER_PRELOAD="$_lib"
        ;;
    esac
    break
  done
fi

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null)" || _self=""
[[ -n "$_self" ]] || _self="${BASH_SOURCE[0]}"
exec "${_self%/*}/termul-manager.AppImage" "$@"
LAUNCHER
    chmod 755 "$target_path" || exit 1
    cat >"$desktop_path" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Termul Manager
Exec=${target_path}
Terminal=false
Categories=Development;Utility;
DESKTOP

    case ":${PATH}:" in
      *":${bin_dir}:"*)
        ;;
      *)
        printf 'Warning: %s is not in PATH. Add it to run termul-manager from your shell.\n' "$bin_dir" >&2
        ;;
    esac

    printf 'Installed Termul Manager to %s\n' "$target_path"
  )
}

main() {
  local os
  local arch
  local version
  local sums_file
  local tmpdir
  local install_dir

  note_legacy_env
  os="$(detect_os)" || return 1
  arch="$(detect_arch)" || return 1
  require_tools "$os" || return 1
  version="$(resolve_version)" || return 1

  case "$os" in
    darwin)
      install_dir="$(brand_env INSTALL_APPLICATIONS_DIR)"
      confirm_install "Install Termul Manager ${version} (${os}-${arch}) to ${install_dir:-/Applications}?" || return 1
      ;;
    linux)
      install_dir="$(brand_env INSTALL_BIN_DIR)"
      confirm_install "Install Termul Manager ${version} (${os}-${arch}) to ${install_dir:-${HOME}/.local/bin}?" || return 1
      ;;
    *)
      die "Unsupported operating system: ${os}"
      return 1
      ;;
  esac

  tmpdir="$(mktemp -d)"
  (
    set -euo pipefail

    termul_main_tmpdir="$tmpdir"
    trap 'rm -rf "${termul_main_tmpdir:-}"' EXIT

    sums_file="$(fetch_sha256sums "$version" "${tmpdir}/SHA256SUMS.txt")" || exit 1

    case "$os" in
      darwin)
        install_macos "$version" "$arch" "$sums_file" || exit 1
        ;;
      linux)
        install_linux "$version" "$arch" "$sums_file" || exit 1
        ;;
    esac
  )
}

if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
