# The GPUIX launcher

The GPUIX app owns a local `termul-server`, the way the Tauri app owns its in-process host. A user starts the app and sees their projects. There is no token to paste and no server to start. This page explains how the launcher finds or starts the server, which files the server uses, and what does not carry over from the Tauri app yet.

The code is in `src/launcher/`. `src/main.tsx` calls `launch()` before it installs the browser environment, so the window always talks to the origin the launcher settled on.

## What happens at launch

1. **Single instance.** The app claims a local socket keyed by the client state dir. On Linux this is an abstract socket, on Windows a named pipe, and on macOS `launcher/instance.sock`. If another window already holds it, the new launch asks that window to focus (`renderer.activateWindow()`) and exits with code 0. It never starts a second server.
2. **Attach.** When `TERMUL_SERVER_URL` is set, the app uses that server as before. It never spawns or stops that server. A protocol mismatch shows the error screen. Other probe results go to the renderer's own auth gate and reconnect loop.
3. **Reuse.** When `launcher/server.json` names a live server for the same data dir (a keep-alive server, or one that outlived a killed app), the app probes it and reuses it. It leaves that server running on quit. If the reused server dies, the app spawns its own on the same port.
4. **Spawn.** Otherwise the app generates a 32-byte token and picks a loopback port: the last port when it is free, else a free one. It starts `termul-server --host 127.0.0.1 --port <port>` on the desktop data dir. The token goes in `TERMUL_WEB_AUTH_TOKEN`, never in argv. The launcher waits up to 30 s for `/health`. It then sends the `/ws` `authenticate` handshake with the client's `WS_PROTOCOL_VERSION` and the token. A refusal becomes the error screen. Only this first start may move to another port when the chosen one is taken.

The binary is `TERMUL_SERVER_BIN`, else `termul-server` next to a compiled app or next to `dist/main.js`, else the first one on `PATH`.

## While it runs

- **Crash.** When the server exits unexpectedly, the window keeps the app mounted and shows a banner across the top ("Termul server stopped (signal SIGKILL). Restarting…"). The supervisor restarts the server on the same port and token after 250 ms, 1 s, 2 s, then 5 s. The renderer's sockets reconnect on their own. Five crashes in a row, each within 30 s of its start, stop the restarts and show the failure with a Retry button.
- **Quit.** Closing the window, SIGINT, SIGTERM or SIGHUP stops a server the app spawned. The launcher sends SIGTERM, waits up to 5 s, then sends SIGKILL, and removes the record. The `exit` hook sends SIGTERM synchronously for exits that skip the signal handlers.
- **Parent death.** A spawned server runs in its own session, so a Ctrl+C in the app's terminal reaches only the app. A POSIX `sh` watchdog polls the app's pid every second. When the app dies without its exit hooks (SIGKILL, a native crash), the watchdog sends SIGTERM to the server, then SIGKILL after 10 s.
- **Logs.** Every boundary goes through `src/log.ts`: spawn, ready with its time, reuse, version mismatch, crash, restart, stop, leaving a server running, and a focus request from a second launch. The token is never logged. Server output goes to `launcher/server.log`, and the previous run's log is kept as `server.log.prev`.

## Files

| Path | Contents |
|---|---|
| `<client state>/launcher/server.json` | pid, port, protocol version, data dir, binary, keep-alive flag (mode 0600) |
| `<client state>/launcher/server-token` | bearer token of the managed server (mode 0600) |
| `<client state>/launcher/last-port` | port to try first on the next launch |
| `<client state>/launcher/server.log` | server stdout and stderr |

The client state dir is `TERMUL_GPUIX_STATE_DIR`, else `$XDG_STATE_HOME/termul-gpuix` (`src/env/config.ts`).

## The server's data dir is the Tauri app's

The server opens the stores the Tauri desktop host keeps in its `app_data_dir` (identifier `com.termul-manager.app`, `src-tauri/tauri.conf.json`):

| Platform | Data dir |
|---|---|
| Linux | `$XDG_DATA_HOME/com.termul-manager.app`, else `~/.local/share/com.termul-manager.app` |
| macOS | `~/Library/Application Support/com.termul-manager.app` |
| Windows | `%APPDATA%\com.termul-manager.app` |

`TERMUL_GPUIX_DATA_DIR` overrides it. The tests use this variable to run under `/tmp`.

| Desktop store (`src-tauri/src/lib.rs`, `data_lock.rs`) | Server flag the launcher passes |
|---|---|
| `<dir>` (state, lock) | `--state-dir <dir>` |
| `<dir>/acp-sessions` | `--sessions-dir <dir>/acp-sessions` |
| `<dir>/projects.json` | `--projects-file <dir>/projects.json` |
| `<dir>/store.json` | `--store-file <dir>/store.json` |
| `<dir>/acp-catalog`, `<dir>/acp-registry-binaries` | follow `--state-dir` (`server_main.rs`) |

Projects, sessions, the ACP catalog and installed agents therefore carry over when a user switches from the Tauri app to GPUIX.

## Gaps

- **Per-device settings do not carry over.** The web store keys every record by device (`device/<deviceId>/<key>`, `src-tauri/src/web/store.rs`). The GPUIX client mints its own device id, so it starts with an empty partition. That partition holds terminal layout, editor state, settings and command history. The Tauri webview's device id lives in WebKit/WebView2 local storage, which the launcher cannot read. A fix needs a store request that adopts another device's partition (category (c)).
- **The device id follows the port.** `src/env` keeps web storage per server origin (`web-storage/<host>.json`), and the device id lives in that storage. The launcher keeps the port across launches to keep the id, but a taken port still resets it. Keying the storage by the managed server's data dir instead of host:port would close this (`src/env`, unit C1).
- **Desktop-only data is not opened.** `acp-chat-history` holds the legacy desktop chat history. The desktop imports it into sessions at startup (`lib.rs:1392,1452`). The server has no such import, so history the desktop never imported stays invisible (inferred from source). The agentation database (`lib.rs:1363`), the plugin-store files (update channel, version skip, release notes) and the desktop log dir (`lib.rs:823`) are also not used.
- **The Tauri app and GPUIX cannot run at the same time.** Both lock the same data dir (AD-14, `data_lock.rs`). GPUIX shows "Another Termul host owns <dir> (pid N)" with a Retry button. This is the intended guard, not corruption.
- **No watchdog on Windows.** The `sh` watchdog is POSIX only. On Windows a killed app leaves its server running. The next launch finds it through `server.json` and reuses it, but nothing stops it if the user never launches again. A Rust `--parent-pid` flag or a Job Object would close this.
- **The window opens after the first start.** `launch()` awaits the first start, so no window shows while the server boots (measured 290-550 ms here). A failed first start still opens the window, with the error screen.
- **macOS single-instance race.** The socket file is removed when a connect is refused. Two launches in the same instant could both pass. Linux and Windows use OS-freed names and have no such race.

## Environment

| Variable | Meaning |
|---|---|
| `TERMUL_SERVER_URL`, `TERMUL_SERVER_TOKEN` | Attach to this server instead of managing one |
| `TERMUL_SERVER_BIN` | The termul-server binary to spawn |
| `TERMUL_GPUIX_DATA_DIR` | Override the server data dir |
| `TERMUL_GPUIX_SERVER_PORT` | Pin the spawned server's port |
| `TERMUL_GPUIX_KEEP_SERVER=1` | Spawn without a watchdog and leave the server running on quit, so the next launch reuses it |

## Verify

```sh
bun tools/launcher/e2e.ts          # writes parity-out/launcher/*.png and results.json
bun test tools/launcher            # paths, probe, supervisor, record, instance, desktop host
```

The e2e takes a free port in 8190-8199 and a free X display, and keeps all state under `/tmp/gpuix-p1-e2e`. Closing the window uses `tools/launcher/close-window.py` (python-xlib through `uv`), which sends `WM_DELETE_WINDOW` as a window manager's close button does.
