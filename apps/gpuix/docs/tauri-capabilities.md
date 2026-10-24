# Tauri-only capabilities in the shared renderer

This inventory lists every capability that the shared renderer (`src/renderer`) gets only from Tauri. For each one it gives the facade, the key call sites, what the web build does today, and where the capability lives once the GPUIX client replaces the Tauri webview.

The GPUIX process runs the shared renderer modules under Bun. `window.__TAURI_INTERNALS__` is undefined there, so `isTauriContext()` returns false (`src/renderer/lib/tauri-runtime.ts:6-11`). `apps/gpuix/build.ts` aliases every `@tauri-apps/*` import to `src/renderer/lib/tauri-stubs/*` (`TAURI_STUB_ALIASES`). Every facade therefore takes its web branch, and the GPUIX client inherits the web build's behavior unless noted.

## How the counts were made

Run the script from `apps/gpuix`:

```sh
bun tools/launcher/inventory.ts            # markdown table
bun tools/launcher/inventory.ts --json     # the same counts as JSON
bun tools/launcher/inventory.ts --sites opener   # file:line of every counted site
```

The counts below were taken at commit `e68111ec` over 943 files. The script skips `__tests__/`, `test-utils/`, `tauri-stubs/` and `*.test.ts(x)`, and it ignores comments. These counts are lower than the ones in `/root/gpuix-research/reports/termul-map.md` section 1.3, which reports 252 `isTauriContext()` sites in 115 files and 54 `api/core` imports. That report read `/root/termul` at `bd01d081`. The difference most likely comes from comments and test files that it counted (inferred, not re-measured).

Column meanings:

- **imports** counts runtime `import` and re-export statements of the capability's packages. A thin facade such as `lib/tauri-window` counts as its package.
- **binding refs** counts calls of the imported names in the files that import them.
- **call sites** counts matches of the capability's `patterns`. These patterns cover facade methods reached through the `lib/api` barrel and DOM attributes.

| id | capability | imports | import files | binding refs | call sites | call-site files |
|---|---|---|---|---|---|---|
| tauri-context | isTauriContext() gates | 0 | 0 | 0 | 213 | 106 |
| web-unsupported | explicit WEB_UNSUPPORTED / NOT_TAURI results | 0 | 0 | 0 | 7 | 5 |
| core-invoke | core invoke | 36 | 33 | 124 | 0 | 0 |
| event-listen | event listen | 10 | 10 | 13 | 0 | 0 |
| window | window controls / state / focus | 8 | 8 | 29 | 10 | 4 |
| drag-region | titlebar drag regions | 0 | 0 | 0 | 19 | 9 |
| webview-browser | webviews and browser panes | 2 | 2 | 1 | 18 | 3 |
| updater | updater | 1 | 1 | 1 | 11 | 8 |
| process | process relaunch / exit | 1 | 1 | 1 | 0 | 0 |
| app-info | app version | 2 | 2 | 5 | 0 | 0 |
| dialog | dialogs / file pickers | 5 | 5 | 12 | 10 | 9 |
| opener | opener / reveal | 2 | 2 | 5 | 12 | 10 |
| notification | notifications | 1 | 1 | 2 | 6 | 6 |
| clipboard | clipboard | 2 | 2 | 7 | 24 | 18 |
| os-info | os info | 4 | 4 | 3 | 2 | 2 |
| global-shortcuts | global shortcuts | 0 | 0 | 0 | 1 | 1 |
| fs | plugin-fs | 5 | 5 | 49 | 0 | 0 |
| path | api/path | 3 | 3 | 4 | 0 | 0 |
| store | plugin-store | 6 | 6 | 6 | 0 | 0 |
| ssh-sessions | SSH sessions | 0 | 0 | 0 | 13 | 1 |
| ssh-sftp | SFTP | 0 | 0 | 0 | 15 | 5 |
| ssh-port-forward | SSH port forwarding | 0 | 0 | 0 | 0 | 0 |
| ssh-keys-import | SSH config import / keys / duplicate | 0 | 0 | 0 | 4 | 2 |
| claude-accounts-manage | Claude account management | 0 | 0 | 0 | 11 | 4 |
| fs-stream-search | streaming content search | 0 | 0 | 0 | 11 | 2 |

The script's `detail` column breaks each row down by binding name and matched text.

## Destination categories

- **(a)** termul-server already serves it. The work is wiring the renderer to that route.
- **(b)** The Bun side of the GPUIX process can provide it, for example with `node:os`, a child process, or the launcher.
- **(c)** It needs a new termul-server route backed by a shared Rust service, per `AGENTS.md` ("Put host-backed behavior in shared Rust services").
- **(d)** It needs native GPUIX work. Citations of the form `D:N` point to lines in `/root/gpuix-research/docs/llms-full.txt`. The issue numbers are on `remorses/gpuix`, as summarized in `/root/gpuix-research/reports/gpuix-capabilities.md`.
- **(e)** Blocked today.

## Capabilities

### Opener: open URL, open with an external app, reveal in the file manager

- **What it does.** It opens a URL in the system browser, opens a file with its default app, or shows a path in the OS file manager.
- **Facade.** `openerApi` in `src/renderer/lib/tauri-opener-api.ts:27-124`, exported through `lib/api.ts:26`.
- **Call sites (12).** `openUrlWithSystemBrowser` has 9, for example `components/WhatsNewModal.tsx:56`, `components/agents/BrowserAuthDialog.tsx:88,99`, `lib/bug-report-api.ts:291` and `lib/browser/terminal-url-navigation.ts:28`. `revealInFileManager` has 2, at `components/file-explorer/FileExplorer.tsx:75` and `components/shell/use-chat-card-actions.ts:108`. `openWithExternalApp` has 1, at `components/file-explorer/FileExplorer.tsx:68`.
- **Web today.**
  - `openUrlWithSystemBrowser` calls `window.open(url, '_blank')` behind an `http(s):`/`mailto:` scheme guard (`tauri-opener-api.ts:50-88`).
  - `openWithExternalApp` and `revealInFileManager` return `WEB_UNSUPPORTED` (`:30-36`, `:103-109`).
  - The file tree hides the reveal and external-open items with `isTauriContext()` (`components/file-explorer/FileTreeContextMenu.tsx:83,140,147`).
- **Before P1 in GPUIX.** The env seam's `window` has no `open` method (`apps/gpuix/src/env/index.ts:82-91`), so `window.open` threw inside the `try` block and the facade returned `OPEN_URL_ERROR` (inferred from `tauri-opener-api.ts`, not run).
- **Destination: (b). Implemented in P1**, see the last section. The Bun side spawns `xdg-open` on Linux (reveal through the freedesktop `FileManager1.ShowItems` D-Bus call, falling back to opening the parent folder), `open` on macOS (`open -R` to reveal), or `explorer` on Windows (`explorer /select,` to reveal). URLs keep the existing scheme guard.

### Notifications

- **What it does.** It shows OS notifications when an agent finishes, a chat needs input, or a terminal exits or goes idle.
- **Facade.** `src/renderer/lib/tauri-notification-api.ts`. `initNotificationPermissions` is at `:36-93` and `sendDesktopNotification` at `:110-169`.
- **Call sites (6).**
  - `hooks/use-agent-chat-notification.ts:88`
  - `hooks/use-chat-notifications.ts:112`
  - `hooks/use-terminal-exit-notification.ts:75`
  - `hooks/use-terminal-idle-notification.ts:115`
  - `TauriApp.tsx:138`, the desktop-only startup permission request
  - the lazy init inside `sendDesktopNotification` (`:117`)
- **Web today.** The facade uses the Web Notifications API (`:66-92`, `:144-168`). When `typeof Notification === 'undefined'`, the permission stays false and every send is a no-op (`:68-71`, `:144`).
- **Before P1 in GPUIX.** Bun has no `Notification` global, so every send was a silent no-op (inferred from the guard above and the Bun globals probe in `gpuix-capabilities.md`, row "DOM globals under Bun").
- **Destination: (b). Implemented in P1** without click handling, see the last section. The Bun side runs `notify-send` on Linux, `osascript -e 'display notification'` on macOS, or a PowerShell toast on Windows. A click that focuses the window needs `notify-send --action --wait` or an equivalent, plus a GPUIX focus call. That part is uncertain because the GPUIX docs list no runtime focus method (D:951-1036).

### Clipboard

- **What it does.** It covers terminal copy and paste, the copy-path, copy-message and copy-code actions, and image paste into the composer.
- **Facades.**
  - `clipboardApi` in `src/renderer/lib/clipboard-api.ts:221-263` is chosen at import time (`:263`).
  - `copyText` in `lib/copy-text.ts:13-51` tries `clipboardApi`, then `navigator.clipboard`, then `execCommand`.
  - Image paste uses `readImage`/`writeImage` from `lib/composer-attachments-io.ts:88,107`.
- **Call sites (24).** There are 10 `clipboardApi.*` calls, for example `hooks/use-terminal-clipboard.ts:94,134,140`, `lib/text-edit-ops.ts:183` and `components/mobile/MobileTerminalControls.tsx:48`. There are 6 `copyText` calls and 8 direct `navigator.clipboard.*` calls, for example `components/AiPromptDialog.tsx:60` and `components/RemoteAccessPopover.tsx:73`.
- **Web today.**
  - `navigator.clipboard` is used when present (`clipboard-api.ts:224-257`).
  - Otherwise a paste-event buffer handles reads and a hidden textarea with `execCommand('copy')` handles writes.
  - `hasImage` always returns false (`:258-260`).
- **In GPUIX today.** Bun has no `navigator.clipboard` (`gpuix-capabilities.md`, row "DOM globals under Bun"). The env seam's `document` is a bare `EventTarget` (`env/index.ts:78-81`). Reads therefore wait for a paste event that never fires. Writes call `document.getElementById`, which does not exist there (inferred from `clipboard-api.ts:102-110` and `:157-200`, not run). GPUIX inputs have native copy and paste, but GPUIX exposes no JS clipboard API (D:1956-1960).
- **Destination: (b).** Text goes through `pbcopy`/`pbpaste`, `wl-copy`/`wl-paste`, `xclip`/`xsel`, or PowerShell `Get-Clipboard`/`Set-Clipboard`. Image paste stays (b) with `wl-paste -t image/png` or `xclip -t image/png`, or (d) through a napi clipboard crate.

### OS info and system

- **What it does.** It answers `platform()` and `arch()` checks, fetches the home directory, and detects resume after sleep.
- **Facades.**
  - `lib/tauri-os.ts:4` re-exports `@tauri-apps/plugin-os`. `lib/agents/acp-registry.ts:10` imports the package directly.
  - `systemApi` lives in `lib/tauri-system-api.ts:64-93`.
- **Call sites.**
  - `platform()` is called at `stores/git-status-store.ts:593` (`isWindows`), `components/agents/AgentLauncher.tsx:1174` (the `.exe` filter) and `lib/agents/acp-registry.ts:277`.
  - `systemApi.getHomeDirectory` is called at `hooks/use-cwd.ts:52`. `systemApi.onPowerResume` is called at `components/terminal/use-terminal-fit.ts:343`.
- **Web today.**
  - The stub returns fixed values: `platform()` gives `'linux'`, `arch()` gives `'x86_64'` and `hostname()` gives `'localhost'` (`tauri-stubs/plugin-os.ts:8-26`).
  - `getHomeDirectory` calls `invoke('get_home_directory')`, which the stub rejects, so it returns `UNKNOWN_ERROR` (`tauri-system-api.ts:66-68`, `lib/ipc/tauri.ts:45-59`).
  - `onPowerResume` is a timer heartbeat, so it already works on every surface.
  - `lib/platform.ts:9` reads `navigator.platform`. Bun on this Linux host reports `Linux` (measured).
- **Destination: (b).** `node:os` provides the values. Mapping `process.platform` to Tauri's names (`darwin` to `macos`, `win32` to `windows`) and `os.arch()` to Rust's names (`x64` to `x86_64`, `arm64` to `aarch64`) fixes the wrong `'linux'` on macOS and Windows. The home directory comes from `os.homedir()`. That value is right because the launcher starts the server as the same local user (`apps/gpuix/src/launcher/server-process.ts`).

### Dialogs and file pickers

- **What it does.** It opens folder pickers for project creation, file pickers for agent binaries, SSH keys and SFTP uploads, save dialogs for SFTP downloads, and confirm prompts for update installs.
- **Facades.**
  - `dialogApi` in `lib/dialog-api.ts`, through `lib/api.ts:17`.
  - `lib/tauri-dialog.ts:5`, used by `lib/confirm-install-update.ts:14`.
  - `lib/tauri-dialog-api.ts`.
  - `composer-attachments-io.ts:30` for attachment pickers.
- **Call sites (10).**
  - `selectDirectory`: `components/NewProjectModal.tsx:393`, `components/ProjectSidebar.tsx:154`, `components/sidebar/project-settings-dialog.tsx:82`, `pages/ProjectSettings.tsx:425`
  - `selectFile`: `components/agents/AgentLauncher.tsx:1171`, `components/settings/AcpAgentsSettings.tsx:145`, `components/ssh/SSHHostEditor.tsx:220`
  - `selectFiles` and `saveFile`: `hooks/use-sftp-transfers.ts:224,264`
  - `registerWebDirectoryPicker`: `components/DirectoryPicker.tsx:250`
- **Web today.**
  - `selectDirectory` calls the in-app picker registered through `registerWebDirectoryPicker` (`dialog-api.ts:25-34`, `:49-54`). That picker is backed by `/fs/browse`.
  - `selectFile` has no web gate, so the stub `open` rejects and it returns `DIALOG_ERROR` (`dialog-api.ts:70-87`, `tauri-stubs/plugin-dialog.ts:11-13`).
  - `selectFiles` and `saveFile` return `CANCELLED` (`:90-92`, `:106-108`).
  - `confirmDialog` rejects (`:134-136`).
- **Destination.**
  - **(d)** for open pickers. GPUIX's `renderer.promptForPaths({ files | directories, multiple })` returns absolute paths (D:992-1023). `registerWebDirectoryPicker` is already a seam that GPUIX can register without editing the renderer.
  - **(e)** for `saveFile`. GPUIX documents no save dialog (D:951-1036). An in-app picker over `/fs/browse` would make it **(a)**.
  - Confirm and message become a GPUIX dialog component (`@gpuix/react/dialog`, D:2263) rather than a native dialog.

### Window controls, window state and close handling

- **What it does.** It covers minimize, maximize and close on Windows and Linux, the close-request guard for running sessions, saving and restoring window geometry, and focus and visibility events.
- **Facades.**
  - `windowApi` in `lib/tauri-window-api.ts:71-177`.
  - `lib/tauri-window.ts:5-13`, which re-exports `getCurrentWindow` and the monitor APIs.
  - `lib/window-focus-api.ts:16-20`.
  - `lib/top-row.ts:126-133` decides `dragRegions`, `windowControls` and `trafficLights` from `isTauriContext()`.
- **Call sites.** There are 29 binding refs, 23 of them `getCurrentWindow`, plus 10 facade calls. Examples:
  - `components/shell/TopRowChrome.tsx:26,43,56,73` (maximize change, minimize, toggle maximize, close)
  - `layouts/workspace-layout/use-app-close.ts:21,62,69,129` (close request and response)
  - `hooks/use-window-state.ts:80,143,179,240,267` (monitors, position, size)
  - `components/ResizeEdges.tsx:98`
  - `hooks/use-visibility-state.ts:152,174`
  - `TauriApp.tsx:185`
- **Web today.** Every `windowApi` method returns early or gives `NO_TAURI` (`tauri-window-api.ts:73-100`). The top row renders no controls (`top-row.ts:127-132`).
- **Destination: (d).**
  - GPUIX has `renderer.minimizeWindow()`, `zoomWindow()` and `toggleFullscreen()` on every desktop platform (D:951-972).
  - Intercepting a close request and reading or setting window position and monitors are not in the GPUIX docs. That gap is inferred from D:951-1036 and `gpuix-capabilities.md` row "Multiple windows". Mark it **(e)** until GPUIX exposes those APIs.

### Titlebar drag regions

- **What it does.** `data-tauri-drag-region` makes custom chrome draggable.
- **Call sites (19 in 9 files).** Examples are `components/shell/ShellFrame.tsx:55`, `components/shell/TopRowChrome.tsx:101`, `components/shell/RailHeader.tsx:23,34,39` and `components/workspace/WorkspaceTabBar.tsx:361-606`.
- **Web today.** A browser ignores the attribute.
- **Destination: (d) or (e).** GPUIX has no drag-region binding (#77). macOS can use `titlebarTransparent`. GNOME on Wayland gets no decorations (#49, #27). See `gpuix-capabilities.md` row "Custom titlebar".

### Global shortcuts

- **What it does.** Nothing at the moment. `keyboardApi.onShortcut` (`layouts/workspace-layout/use-workspace-keyboard.ts:376`) listens for an event that the backend never emits (`lib/tauri-keyboard-api.ts:5-30`, `:63`). No global-shortcut plugin is imported (0 matches).
- **Destination.** None needed. GPUIX has no global shortcuts (#72), and in-window shortcuts go through `onKeyDown`.

### Updater, relaunch and app version

- **What it does.** It checks for, downloads and installs signed desktop updates, picks the update channel, relaunches after install, and shows the app version and release notes.
- **Facades.**
  - `lib/tauri-updater-api.ts`, which calls `check` at `:466`, `relaunch` at `:653` and `getVersion` at `:125,344,415,516`.
  - `stores/updater-store.ts`.
  - `lib/tauri-update-channel.ts`, `lib/tauri-version-skip.ts` and `lib/tauri-release-notes.ts:148`.
- **Call sites (11).**
  - `checkForUpdates`: `hooks/use-updater.ts:60`, `hooks/use-menu-updater-listener.ts:31`, `hooks/use-acp-update-checks.ts:36`, `stores/updater-store.ts:505`, `components/settings/AcpAgentsSettings.tsx:403`
  - `downloadUpdate`: `components/UpdateAvailableToast.tsx:95`
  - `installAndRestart`: `lib/confirm-install-update.ts:27`
  - `setAutoUpdateEnabled`: `pages/AppPreferences.tsx:267`
  - `clearPendingUpdate` and `registerUpdateEventHandlers`: `stores/updater-store.ts:132,323,410`
- **Web today.** The store returns before initializing (`stores/updater-store.ts:354`). The Updates section shows a read-only server version card (comment at `:350-353`).
- **Destination: (b) and (a).**
  - termul-server already updates itself: `--check-update` runs once (`src-tauri/src/server_main.rs:46-49`), and an opt-in loop also exists (`:404`).
  - Updating the GPUIX client bundle and relaunching are launcher jobs in the Bun process. The launcher (`apps/gpuix/src/launcher/`) already restarts the server; relaunching the client itself is not built.
  - The app version can be a build-time constant from `apps/gpuix/package.json`.

### UI zoom

- **What it does.** It applies the UI zoom factor to the webview through `getCurrentWebview().setZoom` (`hooks/use-ui-zoom.ts:55`).
- **Destination: (d), uncertain.** The GPUIX docs read for this inventory show no page-zoom API. A GPUIX port would scale its style tokens instead (guess).

### Browser webviews and browser panes

- **What it does.** It runs in-app browser tabs as native child webviews, with back, forward, reload, devtools, agent injection and navigation events.
- **Facade.** `lib/browser-api.ts:41-125`.
- **Call sites (18 in 3 files).** They are in `hooks/use-browser-webview.ts:66-339`, `components/browser/BrowserControls.tsx:54-119` and `components/browser/BrowserPanel.tsx:26,30`.
- **Web today.** Only `browserTabInjectAgentation` gates and returns `NOT_TAURI` (`browser-api.ts:88-95`). The other functions call `invoke` without a gate, so the stub rejects them (`tauri-stubs/api-core.ts:5-7`).
- **Destination: (e), blocked.** GPUIX has no webview (#69, D:10, D:24). A degraded fallback is to open the URL in the system browser through the opener **(b)**, which loses agent browser automation.

### SSH sessions, SFTP and port forwarding

- **What it does.** It runs SSH terminal sessions with host-key prompts, a remote file browser and editor, uploads and downloads, and port forwards.
- **Facade.** `sshApi` in `lib/ssh-api.ts`. Desktop runs each command as a Tauri command. A web client runs the same command over `/ws` (`sshRequest`) when the host granted the connection `hostLocal`, else it gets `WEB_UNSUPPORTED`. Events arrive from the host's `ssh` watch.
- **Status: (c), done.** termul-server serves every SSH command but port forwarding over `/ws` for `hostLocal` connections (`src-tauri/src/web/ws/ssh.rs`), on the Tauri-free `ssh::service` both transports call. Sessions attach over `/terminal/ws` with the claim the open returns. Ledgered requests (`ssh_session_open`, `ssh_duplicate_profile`, `ssh_import_config`, and the SFTP delete, mkdir, rename and create) carry a `commandId` the transport stamps from `WS_COMMAND_CLASSES`.
- **UI gates.** `SSHPanel`, `SSHHostsView`, `SSHHostEditor`, the sidebar SSH section and the command palette read `useHostGate(canUseHostSsh)`, so the SSH UI appears once the handshake grants `hostLocal`. The host-key browser in `SSHHostEditor` and SFTP upload, download and file drop in `SSHFileExplorer` stay on `isTauriContext()`: they need a local file dialog, which is a Tauri plugin (`lib/dialog-api.ts`). GPUIX needs a native file dialog **(d)** for them.
- **Profiles.** A host-local client keeps profiles in the host's `ssh-profiles.json`. On its first list it moves profiles that an earlier web session kept in the server-side store (`ssh/profiles`) to the host and empties that key.
- **Port forwarding.** Still desktop-only; nothing in the renderer calls it.

### Claude account management

- **What it does.** It adds, signs in, cancels sign-in, renames and removes Claude accounts. Listing accounts, showing usage and choosing accounts already work everywhere.
- **Facade.** `claudeAccountsApi` in `lib/claude-accounts-api.ts`. Desktop runs the Tauri commands; a web client runs the `/ws` requests (`add_claude_account`, `login_claude_account`, `cancel_claude_account_login`, `rename_claude_account`, `remove_claude_account`) only on a `hostLocal` connection, else it rejects with `ClaudeAccountsUnsupportedError`.
- **Status: (c), done.** `src-tauri/src/web/ws/claude_accounts.rs` calls the same `ClaudeAgentService` methods as the Tauri commands. The settings and limit-notice gates read `useHostGate(claudeAccountsApi.canManageAccounts)`.

### Who is `hostLocal`

Both features act with the host user's own credentials, so the peer address is not enough: a reverse proxy or tunnel on the host makes every remote client a loopback peer. A `/ws` connection is `hostLocal` only when all of these hold (`src-tauri/src/web/capabilities.rs`, `web/host_local.rs`):

1. The peer is loopback and the deployment allows writes (not shared-live).
2. The server is token-gated and the client presented the token.
3. The upgrade request has none of the proxy headers in `PROXY_HEADERS` (`Forwarded`, `Via`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, `CF-Ray`, `Tailscale-User-Login`, any case).
4. The client presented the host-local credential. termul-server writes a fresh one to `<state dir>/host-local.token` (mode 0600) at each start.

The GPUIX launcher spawns the server on the app's data dir, so `main.tsx` passes `BootOptions.hostLocalToken`, a reader of that file, and the renderer presents it at each handshake (`lib/web-auth-token.ts` `setHostLocalTokenSource`). An honest browser tab never reads the file, so a browser tab, local or not, is not `hostLocal`. No `/fs/*`, `/search/*` or `fs` watch route serves the file, the bearer-token file or the Claude Account store (`web/host_secrets.rs`). When the app attaches to a server through `TERMUL_SERVER_URL`, it presents the credential only when `TERMUL_GPUIX_DATA_DIR` names that server's `--state-dir` on the same host (`env/config.ts`). An IPv4-mapped loopback peer (`::ffff:127.0.0.1`) is not loopback to `is_loopback()`, so such a client is refused (fails closed).

This guards honest browsers, not bearer-token holders. The token opens a terminal that runs as the server's user, and that shell can read `host-local.token`. A real boundary would need the peer's credentials on a Unix socket (`SO_PEERCRED`), which termul-server does not have.

### Streaming content search

- **What it does.** It streams search results into the file explorer.
- **Facade.** `filesystemApi` in `lib/tauri-filesystem-api.ts`. `searchContentStreamStart` and `searchContentStreamCancel` return `WEB_UNSUPPORTED` (`:463-517`, with the gates at `:472-476` and `:498-502`). `onSearchContentBatch` and `onSearchContentDone` are no-ops on web (`:527-528`).
- **Call sites (11).** Ten are in `stores/file-explorer-store.ts`, with the start at `:950`. One is in `components/file-explorer/use-explorer-search.ts:104`.
- **Web today.** Content search fails on web. The store treats a failed start as an error (`file-explorer-store.ts:985-1000`). That error path was read in the source, not run.
- **Destination: (a).** termul-server already serves `POST /search/content` and `POST /search/cancel` (`src-tauri/src/web/router.rs:272,274`). `webServerSearch.content` already wraps them (`lib/web-server-api.ts:547-563`), but nothing calls it. The facade can run the one-shot search and send the result through the batch and done callbacks. The filename search already does this for issue #848 (`tauri-filesystem-api.ts:545-560`, `lib/web-filename-search.ts:48`). This fix also helps the browser client.

### Filesystem, path and store plugins

- **What it does.** It covers desktop backup and rollback, session snapshots, update-channel and version-skip storage, release-notes state, and writing pasted clipboard images to temporary files.
- **Importers.**
  - `lib/tauri-backup-api.ts`, `lib/tauri-rollback-api.ts`, `lib/tauri-session-api.ts:25,139`, `lib/tauri-update-channel.ts:20`, `lib/tauri-version-skip.ts:11` and `lib/tauri-release-notes.ts:82` use `plugin-fs`, `api/path` and `plugin-store`.
  - `lib/attachment-temp-cleanup.ts:11` and `lib/composer-attachments-io.ts:20-22` use `plugin-fs` for attachments.
  - `lib/tauri-filesystem-api.ts` uses `plugin-fs` only on its desktop branches.
- **Web today.**
  - File operations go over `/fs/*`.
  - Settings go over the `/ws` store (`termul-map.md` section 1.2).
  - `plugin-store` is backed by `localStorage` (`tauri-stubs/plugin-store.ts`). The GPUIX env seam makes that storage a per-origin file (`apps/gpuix/src/env/index.ts:46-49`).
  - `sessionApi`, `dataMigrationApi` and `secureStorageApi` are always bound to Tauri adapters (`lib/api.ts:36-42`).
- **Destination.**
  - **(a)** for files and settings.
  - **(b)** for writing attachment temp files, through `node:fs` with `os.tmpdir()`.
  - Backup and rollback serve the Tauri updater and go away with it (inferred).

### Event listen and core invoke

- **Counts.** There are 13 `listen` refs in 10 files and 124 invoke refs in 33 files: 88 `invoke`, 26 `invokeIpc`, 6 `invokeIpcWrapped`, 3 `Channel` and 1 `invokeTauriIpc`.
- **Destination.** None of its own. These are the desktop halves of facades that the sections above already cover. The web branch replaces each one.

## Implemented in P1 (b)

The seam is `src/renderer/lib/desktop-host.ts`. A non-Tauri desktop shell calls `registerDesktopHost()` with all four capabilities (`openUrl`, `openPath`, `revealItemInDir`, `notify`). The opener and notification facades consult `getDesktopHost()` only on their non-Tauri branch. Tauri never reaches the host, and a browser registers none, so both keep their behavior. The GPUIX implementation is `apps/gpuix/src/launcher/desktop-host.ts`: one argv table per platform and action, tried in order until a command exits 0. User text is always its own argv entry, or an environment variable for the PowerShell notification, never part of a shell string. `apps/gpuix/src/main.tsx` creates the host and `boot.tsx` registers it before the window opens.

| Capability | Facade change | GPUIX command (Linux / macOS / Windows) | Tests |
|---|---|---|---|
| Open URL | `openUrlWithSystemBrowser`: after the scheme guard, host `openUrl`; a rejection maps to `OPEN_URL_ERROR` | `xdg-open` / `open` / `rundll32 url.dll,FileProtocolHandler` | `src/renderer/lib/__tests__/desktop-host.web.test.ts` (routes to host, error codes, `javascript:` never reaches the host, no-host unchanged) |
| Open with external app | `openWithExternalApp`: host `openPath`; rejection maps to `OPEN_ERROR` | `xdg-open` / `open` / `explorer.exe` | same file |
| Reveal in file manager | `revealInFileManager`: host `revealItemInDir`; rejection maps to `REVEAL_ERROR` | `gdbus … FileManager1.ShowItems`, then `xdg-open <parent>` / `open -R` / `explorer.exe /select,` | same file; argv and fallback order in `apps/gpuix/tools/launcher/launcher.test.ts` |
| Notifications | with a host, permission is granted without a prompt and `sendDesktopNotification` calls host `notify`; a failure is logged through `logFrontendError`, never thrown | `notify-send --app-name=Termul` / `osascript` with `on run argv` / PowerShell `NotifyIcon` balloon | `desktop-host.web.test.ts` (host send, no Web Notification constructed or prompted, failure logged); argv in `launcher.test.ts` |

The parity checklist pins the wiring in `Desktop host seam parity (GPUIX)` at the end of `src/renderer/lib/__tests__/parity-checklist.test.ts`. The existing `tauri-opener-api.web.test.ts` and `tauri-notification-api.web.test.ts` suites pass unchanged.

Limits:

- The commands were unit-tested as argv. They were not run against a real desktop session: this host has no `xdg-open`, `notify-send` or file manager. The macOS and Windows commands are untested.
- A notification click does not focus the window. `notify-send --wait --action` could report it, and `renderer.activateWindow()` (D:840) could focus the window. That work is a follow-up.
- `canRevealInFileManager`-style UI gates still read `isTauriContext()` (`FileTreeContextMenu.tsx:83`). The GPUIX ports of those components need to check `getDesktopHost()` instead.

Cheap (b) items left for the env seam owner (unit C1 owns `apps/gpuix/src/env` and `build.ts`):

- Clipboard text through `navigator.clipboard` defined in the env seam. That one definition covers all 24 sites.
- OS info: point the `@tauri-apps/plugin-os` alias at a `node:os` module.
