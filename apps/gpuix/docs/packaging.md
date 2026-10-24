# Packaging the GPUIX app for Linux

`bun run package:linux` in `apps/gpuix` builds a Debian package of the GPUIX desktop app for Linux x64. The package carries everything the app runs: the Bun runtime, the client bundle, its fonts, the GPUIX native addon, a release `termul-server`, ripgrep, and the browser-pane webview helper. A user installs it and starts "Termul Manager (GPUIX)" from the application menu, or runs `termul-gpuix`. No checkout, Bun install, or server setup is needed.

The code is in `packaging/`. `packaging/linux/layout.ts` holds the names, paths, dependencies and file templates. `packaging/linux/package.ts` builds the package. `packaging/linux/verify.ts` is the acceptance check.

## Build

```sh
cd apps/gpuix
CARGO_TARGET_DIR=<a target dir with the desktop build> bun run package:linux
```

The output is `dist-package/termul-gpuix_<version>_amd64.deb`. The version is the repo's `package.json` version, the same as the Tauri app. `--out DIR` writes it elsewhere.

The script does these steps in order:

1. Bundle the client in production mode (`buildClient` from `build.ts`) into the package's `dist/`, and bundle `packaging/update-check.ts` beside it. Source maps are left out.
2. Install the runtime packages with `bun install --production` from `bun.lock`. These are the packages the bundle keeps external: `react`, `react-dom`, `@gpuix/react` and `@gpuix/native` with `@gpuix/native-linux-x64-gnu`. The wasm build of `@gpuix/native` (20 MB, browser only) is removed.
3. Copy the Bun binary that runs the script.
4. Build `termul-server` with `cargo build --release --bin termul-server --features standalone-server`. The server embeds `dist-web/`. The script runs `bun run build:web` first only when `dist-web/index.html` is missing, because a rebuilt `dist-web/` makes cargo recompile the server crate. Pass `--rebuild-web` to force it.
5. Build `native/webview-host` with `cargo build --release`.
6. Strip every ELF file in the package. Each binary is copied before it is stripped, so the cargo artifacts are not changed.
7. Write the wrapper, the `/usr/bin` link, the `.desktop` entry and the icons, then run `dpkg-deb --build --root-owner-group -Zxz`.

`--server-bin FILE` and `--webview-host FILE` use prebuilt binaries and skip cargo for that binary. Cargo writes to `$CARGO_TARGET_DIR`, else `src-tauri/target`. Before each cargo build the script stops if the disk has less than 8 GiB free.

## What the package installs

| Path | Contents |
|---|---|
| `/opt/termul-gpuix/termul-gpuix` | `sh` wrapper that runs `bun dist/main.js` |
| `/opt/termul-gpuix/bun` | the Bun runtime |
| `/opt/termul-gpuix/dist/` | `main.js` and its chunks, `check-update.js`, the terminal fonts, `termul-server`, `rg`, `termul-webview-host` |
| `/opt/termul-gpuix/assets/fonts/` | the UI fonts (Inter, Paper Mono) |
| `/opt/termul-gpuix/node_modules/` | the runtime packages |
| `/usr/bin/termul-gpuix` | relative link to the wrapper |
| `/usr/share/applications/com.termul-manager.gpuix.desktop` | menu entry, `StartupWMClass=com.termul-manager.gpuix` |
| `/usr/share/icons/hicolor/<size>/apps/termul-gpuix.png` | the Tauri app's icons, 32 to 512 px |

The launcher already looks for `termul-server` beside the bundle (`src/launcher/paths.ts`), and the browser host looks for `termul-webview-host` there too (`src/browser/support.ts`). The server looks for `rg` beside its own executable (`src-tauri/src/commands/search.rs`). The package therefore needs no new lookup code.

The wrapper passes `--no-install`, `--no-env-file` and `--config=/opt/termul-gpuix/bunfig.toml` to Bun. Without them, a `.env` or `bunfig.toml` in the directory the user starts the app from would reach the app.

The window sets `appId: 'com.termul-manager.gpuix'` (`src/window.ts`), which becomes the X11 `WM_CLASS`. The `.desktop` entry's `StartupWMClass` matches it, so a desktop groups the window under the menu entry.

## Side by side with the Tauri app

The names differ from the Tauri package, so both packages can be installed at the same time:

| | Tauri | GPUIX |
|---|---|---|
| Package | `termul-manager` | `termul-gpuix` |
| Menu name | Termul Manager | Termul Manager (GPUIX) |
| Command | `termul-manager` | `termul-gpuix` |

The Tauri column comes from `src-tauri/tauri.conf.json` and the cargo package name. It was not checked against a built Tauri `.deb`.

Both apps open the same data dir, `~/.local/share/com.termul-manager.app` (see [launcher.md](./launcher.md)). A user who switches keeps their projects and sessions. The data-dir lock lets only one app run at a time. The second one shows "Another Termul host owns …".

## System requirements

| Need | Debian/Ubuntu package | Used by |
|---|---|---|
| X11 keyboard and connection | `libxcb1`, `libxkbcommon0`, `libxkbcommon-x11-0` | the GPUIX addon (linked) |
| Vulkan loader | `libvulkan1` | the GPUIX addon (loaded at run time) |
| Vulkan driver | `mesa-vulkan-drivers` (Intel, AMD, lavapipe), or the NVIDIA driver | the GPUIX addon |
| WebKitGTK 4.1 and GTK 3 | `libwebkit2gtk-4.1-0`, `libgtk-3-0` | `termul-webview-host`, and `termul-server` (the server binary links them through the shared Tauri crate) |

The `.deb` lists these packages in `Depends`, with the Vulkan driver in `Recommends`. The names also exist on Debian 12 and Ubuntu 22.04. On Ubuntu 24.04, `libgtk-3-0t64` provides `libgtk-3-0`. `package:verify` runs `ldd` on every ELF file in the package and fails when a library is missing.

Browser panes need GPUI on X11. Under a Wayland session (`WAYLAND_DISPLAY` set), GPUI uses Wayland and the app turns browser panes off (`src/browser/support.ts`). The rest of the app works.

## Updates

The app checks for updates but never installs them. `termul-gpuix --check-update` reads the Tauri updater feed, `plugins.updater.endpoints[0]` in `src-tauri/tauri.conf.json` (`…/releases/latest/download/latest.json`). It compares the feed's `version` with the packaged version and prints one line:

- `Termul Manager (GPUIX) 0.4.52 is up to date (latest release 0.4.52).`
- `Termul Manager 0.4.53 is available (this GPUIX build is 0.4.52). Download: <url>`

The feed has no GPUIX asset yet. The checker reads the key `linux-x86_64-gpuix-deb`, following kybern's `darwin-<arch>-gpuix` keys. While the key is missing, the checker names the Tauri `.deb` of that release. A release workflow that uploads the GPUIX `.deb` and adds that key to `latest.json` makes the link point at the GPUIX package. Nothing else needs to change.

Why the app does not install updates:

- GPUIX's `checkUpdate` (cargo-packager) reads GitHub Releases, needs a cargo-packager signing key, and does not restart the app. Termul's feed is a Tauri `latest.json` signed with minisign.
- A `.deb` installs into `/opt` as root, so the app cannot replace itself. Updates belong to the package manager (an apt repository) or to a user-owned format such as an AppImage.

The bundled `termul-server` does not update itself. Its self-update runs only with `TERMUL_SERVER_UPDATE_ENABLED=true`, and a build without the `TAURI_SIGNING_PUBLIC_KEY` secret has no key to verify an update with (`src-tauri/src/server_update.rs`). If it did update, it would try to replace a root-owned file in `/opt`.

## Verify

```sh
bun run package:verify                       # the package in dist-package/
bun run package:verify -- --deb FILE --root /tmp/gpuix-<unit> --runs 5
```

The check extracts the `.deb` with `dpkg-deb -x` into `<root>/install` and never installs it system-wide. It then:

1. Checks that every ELF file resolves its libraries with `ldd`.
2. Runs `termul-gpuix --version` and `--check-update` with `env -i HOME=<root>/home PATH=/usr/bin:/bin`.
3. Starts Xvfb with the lavapipe Vulkan driver. It runs `usr/bin/termul-gpuix` with that clean environment plus `DISPLAY`, `VK_ICD_FILENAMES`, `GPUIX_BACKGROUND=1`, `GPUIX_WINDOW_SIZE`, `TERMUL_GPUIX_DATA_DIR=<root>/data` and a test port in 8190-8199.
4. Checks that the app process is the packaged `bun` and that the server it spawned is the packaged `termul-server`.
5. Adds a project, opens its dashboard, opens a terminal and runs a command, then opens a browser tab and loads a local page in the packaged webview helper. It takes a PNG of each.
6. Closes the window with `WM_DELETE_WINDOW`. It then checks that every process the app started has exited, including the server, the watchdog, the shell, the helper and the WebKit processes, and that the server port is closed.
7. Launches the app `--runs` more times and times each launch, from spawn until the project rail is painted.

PNGs and `results.json` go to `parity-out/packaging/`.

## Measured

Measured on 2026-10-25 on this host: 8 cores, Xvfb with lavapipe (software Vulkan), with other units' benchmarks running at the same time.

| | |
|---|---|
| `.deb` size | MEASURE_DEB |
| Installed size | MEASURE_INSTALLED |
| Startup, spawn to painted project rail | MEASURE_STARTUP |
| Server ready (spawn to authenticated `/ws`), from the launcher log | MEASURE_SERVER |
| Quit, `WM_DELETE_WINDOW` to no process left | MEASURE_QUIT |

## Not done

- **No AppImage.** cargo-packager and appimagetool are not installed here. An AppImage needs the AppImage runtime, so it is a separate unit. That unit should also add self-update, because an AppImage is a user-owned file.
- **No `bun build --compile`.** A compiled probe that imports `@gpuix/native` failed with "Cannot find native binding": the napi loader loads the addon by a dynamic path, so `--compile` does not embed it (measured with Bun 1.4.0). Kybern ships the `.node` beside a compiled binary and sets `NAPI_RS_NATIVE_LIBRARY_PATH`. The GPUIX entry also resolves `@gpuix/react`'s reconciler file and the font directory from disk (`src/main.tsx`). A compiled binary would still contain Bun, so it would not be much smaller than the directory layout (inferred).
- **No signing.** The `.deb` is unsigned, like local builds of the Tauri app.
- **x64 only.** `@gpuix/native` 0.11.0 has no `aarch64-unknown-linux-gnu` build.
