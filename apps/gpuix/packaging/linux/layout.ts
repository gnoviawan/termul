/**
 * What the Linux package is called and where its files go. The names stay distinct from the
 * Tauri package (`termul-manager`, `/usr/bin/termul-manager`, "Termul Manager") so both install
 * side by side. Both still open the same data dir (`com.termul-manager.app`, see
 * `src/launcher/paths.ts`), and the data-dir lock lets only one of them run at a time.
 */

import { DESKTOP_WINDOW } from '../../src/window'

export const PACKAGE_NAME = 'termul-gpuix'
export const PRODUCT_NAME = 'Termul Manager (GPUIX)'
/** The window's X11 `WM_CLASS`, the .desktop file's basename and its StartupWMClass. */
export const APP_ID = DESKTOP_WINDOW.appId
export const INSTALL_DIR = `/opt/${PACKAGE_NAME}`
/** Tauri's `bundle.publisher`. */
export const MAINTAINER = 'gnoviawan'
export const HOMEPAGE = 'https://github.com/gnoviawan/termul'

/**
 * Runtime libraries, as package names that exist on Debian 12 and Ubuntu 22.04/24.04 (24.04's
 * `t64` packages provide the old names). They cover the ELF files in the package:
 * - the GPUIX addon links libxcb, libxkbcommon, libxkbcommon-x11, and dlopens libvulkan.so.1;
 * - termul-server and termul-webview-host link webkit2gtk-4.1 and GTK 3 (the server through
 *   the shared Tauri crate), the same pair the Tauri .deb depends on.
 * `verify.ts` runs `ldd` on every ELF file of the extracted package and fails on a missing one.
 */
export const DEPENDS = [
  'libc6',
  'libxcb1',
  'libxkbcommon0',
  'libxkbcommon-x11-0',
  'libvulkan1',
  'libwebkit2gtk-4.1-0',
  'libgtk-3-0'
]
/** A Vulkan driver: Mesa's covers Intel, AMD and lavapipe (software). NVIDIA ships its own ICD. */
export const RECOMMENDS = ['mesa-vulkan-drivers | vulkan-icd']

/** Hicolor icon sizes, from the Tauri app's icons. */
export const ICONS: ReadonlyArray<{ size: string; source: string }> = [
  { size: '32x32', source: 'src-tauri/icons/32x32.png' },
  { size: '64x64', source: 'src-tauri/icons/64x64.png' },
  { size: '128x128', source: 'src-tauri/icons/128x128.png' },
  { size: '256x256', source: 'src-tauri/icons/128x128@2x.png' },
  { size: '512x512', source: 'src-tauri/icons/icon.png' }
]

/** ripgrep for file search: termul-server looks for `rg` beside its executable (`commands/search.rs`). */
export const RIPGREP_SOURCE = 'src-tauri/bin/rg-x86_64-unknown-linux-musl'

/** The wrapper `/usr/bin/termul-gpuix` points at. `@VERSION@` is filled in at package time. */
export const WRAPPER = `#!/bin/sh
# ${PRODUCT_NAME}: the bundled Bun runs the bundled client. The flags keep a bunfig.toml or
# .env in the caller's working directory from reaching the app.
set -e
here=$(dirname "$(readlink -f "$0")")
case "$1" in
  --version) echo "${PACKAGE_NAME} @VERSION@"; exit 0 ;;
  --check-update) shift; exec "$here/bun" --no-install --no-env-file --config="$here/bunfig.toml" "$here/dist/check-update.js" "$@" ;;
esac
exec "$here/bun" --no-install --no-env-file --config="$here/bunfig.toml" "$here/dist/main.js" "$@"
`

export function desktopEntry(): string {
  return `[Desktop Entry]
Type=Application
Name=${PRODUCT_NAME}
GenericName=Terminal Manager
Comment=Project-aware terminal manager, native GPUIX client
Exec=${PACKAGE_NAME}
Icon=${PACKAGE_NAME}
Terminal=false
Categories=Development;Utility;
StartupWMClass=${APP_ID}
`
}

export function controlFile(fields: { version: string; installedKb: number }): string {
  return `Package: ${PACKAGE_NAME}
Version: ${fields.version}
Architecture: amd64
Maintainer: ${MAINTAINER}
Installed-Size: ${fields.installedKb}
Depends: ${DEPENDS.join(', ')}
Recommends: ${RECOMMENDS.join(', ')}
Section: devel
Priority: optional
Homepage: ${HOMEPAGE}
Description: ${PRODUCT_NAME}, experimental native client
 Termul's desktop client rendered with GPUIX (React on Zed's GPUI) instead of a
 webview. It starts a bundled termul-server on loopback and talks to it over
 Termul's web transport. Installs beside the Tauri termul-manager package.
`
}
