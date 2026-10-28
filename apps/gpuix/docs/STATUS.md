# GPUIX client: status

Checked on 2026-10-28 at `gpuix/m5` (`exp/gpuix-client` at c037d87e plus
M5's test and doc commits). Every number here was measured on that head on
one Linux machine with no GPU.

## What it is

The GPUIX client is a new Termul desktop app. It draws the same screens as
the Termul web client, but with native GPU rendering (Zed's GPUI, through
GPUIX, a React renderer for it) instead of a web view. It talks to a
`termul-server` it starts for you, over the same HTTP and WebSocket
connection the browser client uses. The stores and screens are Termul's
own code from `src/renderer`, not a copy.

The goal is that a user sees the same app and finds it faster. Today's web
client and Tauri app keep working as they are.

## Build, run and install

Linux x64 on X11 is the tested platform.

To install the package:

```sh
sudo apt install ./termul-gpuix_0.4.52_amd64.deb
termul-gpuix                      # or "Termul Manager (GPUIX)" in the app menu
```

The package installs under `/opt/termul-gpuix` with its own Bun, the app,
the patched GPUIX addon, a `termul-server`, ripgrep and the browser-pane
helper. It opens the same data dir as the Tauri app, so projects and chats
carry over. Only one of the two apps can run at a time. The app never
installs updates itself; `termul-gpuix --check-update` reports a newer
release.

To build the package from a checkout, from `apps/gpuix`:

```sh
bun install
bun run native:build              # the patched addon; seconds when unchanged, about 20 min cold
CARGO_TARGET_DIR=<target dir with the desktop build> bun run package:linux
bun run package:verify            # extracts and drives the .deb under Xvfb
```

To run from a checkout without touching your real data:

```sh
export NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/gpuix-native/build/gpuix-native.linux-x64-gnu.node
TERMUL_SERVER_BIN=../../src-tauri/target/release/termul-server \
TERMUL_GPUIX_DATA_DIR=/tmp/termul-gpuix-try bun run dev
```

[README.md](../README.md) has every variable, and
[packaging.md](./packaging.md) has the package layout and requirements.

PACKAGE_RESULT

## Design and behavior parity

PARITY_RESULT

## Performance

PERF_RESULT

## Not done or limited by the platform

- **macOS and Windows are untested.** The code has paths for both (data
  dirs, launcher), but no build or run was made on either. There is no
  package for them.
- **Linux arm64 has no build.** `@gpuix/native` 0.11.0 ships x64 only.
- **Browser panes need X11.** Under a Wayland session GPUI uses Wayland and
  the app turns browser panes off. The rest of the app works.
- **Remote access cannot be turned on.** The popover shows the switch
  disabled with "Not available in this build yet", because `termul-server`
  has no guard that keeps a shared link read-only the way the desktop host
  does.
- **The agent list in Settings, Agent chats, can fall back to its loading
  card** after it has loaded (2 of 3 matrix runs). Not traced yet.
- **The package is a `.deb` only.** It is unsigned, and there is no
  AppImage or self-update.
- **Natively painted text is not readable by automation** (editor, chat
  prose, terminal cells). The parity runs judge those surfaces from the
  pixels instead.

## Changes in shared code that reach today's web and Tauri users

The GPUIX work changed code that the web client, the browser/phone UI and
the Tauri app also run. These are the commit subjects from
`git log dev..HEAD -- src/ src-tauri/ website-docs/` (55 commits, newest
first, merges left out), grouped by what a user of today's apps could
notice.

**Server and connection security (`termul-server`, so the browser and phone UI; the desktop's shared-live host where it shares the code).**

- `a1d4de157` fix(server): prove host-locality with an owner-only credential, not the peer address
- `0b07ebeee` fix(server): no file route serves the host-local credential or other state-dir secrets
- `92a06d4e2` fix(ws): treat Via, X-Forwarded-Host/Proto, client-IP, Cf-Ray and Tailscale headers as a proxy
- `d94f62c2d` fix(ws): host-local parse errors never repeat a value the client sent
- `9c79419dc` fix(ws): stamp a commandId on every host-local request the host ledgers
- `7b80889dd` fix(ws): ledger the SFTP delete, mkdir, rename and create commands
- `bb4cbd789` feat(server): SSH sessions, SFTP, profiles and keys over /ws for host-local clients
- `3438b3886` feat(server): Claude account management over /ws for host-local clients

**SSH and accounts in the web UI (shown wherever the host runs SSH or Claude accounts for the client).**

- `5494835a5` feat(ssh): show the SSH UI wherever the host runs SSH for the client
- `fc031f2a0` feat(ssh): canUseHostSsh predicate for synchronous UI gates
- `c3c0b3a84` fix(ssh): move web-store SSH profiles to the host on the first host-local list
- `2e80d130d` fix(ssh): copy web-store SSH profiles to the host once and leave the store intact
- `7ca33d78d` fix(ssh): fsync the profile store and stop serving profiles from a stale copy
- `df234b75b` fix(ssh): copy store profiles to the host once per client and keep a lost marker race quiet
- `a409e0b72` fix(ssh): the SFTP Modified column fits a 12-hour time (C14)
- `a45e2d62b` fix(renderer): re-render the host-credential gates when the handshake grants them

**Behavior fixes in the shared renderer (web client and Tauri app).**

- `86901fef7` feat(agents): catalog loading state and bounded retry for agent chats settings
- `71d47845e` fix(web): keep the zoomed shell and floating menus in place under CSS zoom (WEB-ZOOM)
- `0d2ca0de8` fix(settings): Escape closes Preferences unless a shortcut is being recorded
- `5cff371e2` fix(workspace): one error boundary per pane tab, so a crashing tab leaves its siblings mounted
- `b441d377a` fix(palette): focus the search in the commit that opens the palette
- `0ec15ef3c` fix(workspace): a store-made chat route does not re-activate its chat late
- `fe9f74d34` fix(workspace): a placeholder remap renames the chat in place
- `94b204219` fix(launcher): restore the last-selected agent only after the agent configs load (G10 CONFIG-RACE)
- `ba8d7f7c1` fix(launcher): a send before the last-selected agent restores waits for it (G8 AGENT-PICK)
- `978bcaf6c` fix(acp): a host-owner adoption no longer takes the reuse key from the agent a new chat runs on (G11 LABEL)
- `474e0998d` fix(workspace): the first project commit keeps the placeholder tree, so the boot launcher is not remounted (G10 BOOT-REMOUNT)
- `b34e4f36a` revert(workspace): back out the BOOT-REMOUNT placeholder adoption (G10)
- `520e4f4d0` fix(workspace): the first project commit keeps the placeholder tree, so the boot launcher is not remounted (G10 BOOT-REMOUNT)
- `2ecce9326` fix(gpuix): Logs names the server's own version; the bundle defines the app version (O9). The web client's Settings, Logs now shows the version the server reports instead of the bundle's version.

**Desktop (Tauri) only.**

- `c12eed3a5` fix(desktop): report browser tab page titles from WebKit (DESKTOP-TITLES)

**Seams for the GPUIX host.** These take effect only when a non-Tauri desktop host registers, so today's web and Tauri apps keep their old behavior (from the commit subjects and the files they touch; not re-tested in M5).

- `13f39faa4` feat(renderer): desktop host seam for openers and notifications
- `7eeaafd4c` feat(renderer): browser host seam so a non-Tauri desktop shell can host browser panes (B2)
- `87c2473f8` feat(gpuix): helper-backed browser host registered through the seam, with keyboard pairing (B2)
- `81142b0f0` feat(gpuix): overlays hide browser webviews (ui twins and the Preferences modal register occluders); show/hide by container map state (B2)
- `a93e9f656` feat(gpuix): the canvas runs in a helper webview whose relay page frames FigCraft and passes the bridge's postMessage traffic (V1)
- `5129e3d76` fix(gpuix): the canvas gets Termul's theme from the GPUIX theme, not the document's computed style (V1)
- `f052058cb` feat(gpuix): native file dialogs behind the desktop host seam (G7 ATTACH)
- `1753fdc3e` feat(gpuix): a registered desktop host gets the desktop keymap (K2)
- `ad454579e` feat(gpuix): update toast and What's New through the desktop host seam (U1)
- `44e39dc33` feat(gpuix): remote access popover in GPUIX, gated without the shared-live host (R4)

**Refactors, docs and tests with no intended behavior change.**

- `130fc19a3` refactor(themes): extract pure resolveThemeTokens from applyColorTheme
- `dd8c4b6d1` refactor(ui): move the button, badge and sheet cva tables into their own modules
- `bb2daa1fe` refactor(renderer): pure file-path matching module; export localLinkPath
- `b226fd878` refactor(chat): route composer editor operations through editor-ops
- `8c34b1728` refactor(composer): export pillTokenText from doc-to-prompt
- `e0f06344d` refactor(renderer): pure terminal seams for the native client
- `9bc9ff64e` refactor(chat): export TurnActivity's run grouping, open state, trigger and entry
- `bda70ad28` docs(renderer): host-local means holding the host-local credential
- `5bf94ea7a` style(workspace): biome format the tab boundary
- `66fa2889f` build(gpuix): typecheck the terminal under Bun types
- `c044fd8ee` test: pin the terminal clipboard degrade path in clipboard-key.ts; shell check covers the assist panel
- `b367b9a9d` test(workspace): reproduce the placeholder remap closing a reopened launcher
- `722f3b3e4` test(workspace): reproduce the chat route's late first run closing a reopened launcher
- `b81e204a2` test(palette): reproduce type-ahead lost between Ctrl+K and the deferred focus
