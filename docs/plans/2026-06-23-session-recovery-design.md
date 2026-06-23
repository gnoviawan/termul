# Session Recovery Design

Date: 2026-06-23

## Goal

Add Termul session recovery for bad shutdowns, app freezes, force closes, and normal close with live work. Restore all workspace-visible state. Keep local CLI sessions running in background when Termul UI exits or crashes.

## Scope

Recovery scope is **D**: all workspace-visible state.

- Terminal: live process survival and reattach.
- ACP: best-effort live agent/process recovery plus persisted `session_id` metadata.
- SSH/SFTP: restore tabs/profiles and reconnect; remote process survival depends on remote `tmux`, `screen`, `nohup`, etc.
- Browser/editor/workspace: restore layout and metadata; no live process survival needed.

## Architecture

Termul uses a split process model:

- Tauri UI process is a disposable client.
- `termul-supervisor` is a durable sidecar daemon and session owner.

Current PTY/process ownership moves from Tauri `PtyManager` into `termul-supervisor`. Tauri calls supervisor over local IPC for terminal/session commands. Supervisor owns PTY masters, child process PIDs/process groups, scrollback ring, cwd/git/exit trackers, terminal metadata, and session persistence.

Tauri still owns renderer, workspace layout UI, menus, dialogs, browser/editor UI, app settings, and recovery UX. On startup, Tauri ensures supervisor exists, connects to it, calls `list_sessions`, and rehydrates workspace state.

If previous shutdown was not clean, UI restores workspace automatically but terminals appear as paused reconnectable surfaces until user opens them. On attach, xterm receives scrollback replay and then live output stream.

If supervisor dies too, persisted sessions are marked `lost`. UI keeps last known metadata and scrollback journal, then offers restart/open logs.

## Shutdown policy

If user closes Termul normally:

1. No live sessions: exit; set `last_shutdown=clean`; supervisor exits.
2. Live sessions: show modal with:
   - **Keep running**: close UI; supervisor and child CLI sessions keep running; set `last_shutdown=keep_running`.
   - **Kill all**: supervisor terminates process groups; mark sessions `exited`; set `last_shutdown=clean`; exit.
   - **Cancel**: app stays open; no state change.

If Termul crashes, freezes, or is force killed, supervisor keeps CLI sessions alive. On next launch, stale heartbeat + non-clean shutdown becomes `last_shutdown=crashed_or_unknown`.

## Persistence

Supervisor persists session truth, not renderer cache.

Main file:

- app data `sessions.json`

Properties:

- atomic writes
- schema-versioned
- small registry file
- append-only per-session output journals for scrollback replay

Top-level fields:

- `schema_version`
- `supervisor_pid`
- `last_shutdown`: `clean | keep_running | crashed_or_unknown`
- `last_heartbeat_at`
- `sessions[]`

Session fields:

- `session_id`
- `workspace_id` / `project_id`
- `pane` / `tab` binding
- `kind`: `terminal | acp | ssh | browser | editor`
- `status`: `running | exited | detached | lost`
- `pid`
- `process_group_id`
- `command`
- `args`
- `shell`
- `cwd`
- safe env allowlist only
- `cols`
- `rows`
- `created_at`
- `updated_at`
- `last_attached_at`
- `scrollback_journal_path`
- `exit_code`
- `recovery_reason`

Write rules:

- On `spawn`: create registry row before/around child creation.
- On `write`, `resize`, `cwd`, `git`, `exit`: update metadata, throttled.
- On output: append compact journal chunks.
- On `kill`: mark `exited`, store exit code.
- On clean close with no live sessions or after Kill all: set `last_shutdown=clean`.
- On Keep running: set `last_shutdown=keep_running`.
- On startup with stale heartbeat and no clean marker: classify as `crashed_or_unknown`.

## Recovery startup behavior

Startup reads supervisor state and registry.

- `last_shutdown=clean`: normal startup, no recovery banner.
- `last_shutdown=keep_running`: restore workspace, show paused terminals as still running and attachable.
- `last_shutdown=crashed_or_unknown`: restore workspace, show recovery banner, show paused attachable terminals.
- Missing PID/dead PTY/stale supervisor: mark session `lost`, keep scrollback snapshot, offer restart.

Renderer surfaces should use `recoveryStatus`:

- `live_attachable`
- `needs_reconnect`
- `lost`
- `restored`

## IPC

Supervisor IPC is local-only, authenticated, and versioned.

Transport:

- Unix domain socket on macOS/Linux.
- Named pipe on Windows.

Socket/pipe metadata lives in app data beside `sessions.json`.

Handshake:

```text
UI -> supervisor: hello { protocol_version, app_instance_id }
supervisor -> UI: hello_ack { supervisor_pid, protocol_version, capabilities }
```

Commands:

- `spawn`
- `write`
- `resize`
- `kill`
- `read`
- `list_sessions`
- `attach`
- `detach`
- `shutdown`

Events:

- `session_output`
- `session_status_changed`
- `cwd_changed`
- `git_changed`
- `exit_code_changed`
- `supervisor_health_changed`

Security:

- Socket path under user app-data dir with user-only permissions.
- Random auth token generated at supervisor start, stored in user-only file or passed via inherited pipe.
- Never persist full env; persist only safe env allowlist.

## Process lifecycle

- Supervisor starts detached from Tauri process group.
- Each terminal child gets its own process group.
- UI close uses `detach`, not `kill`.
- Crash does not need detach; heartbeat timeout clears client attachment.
- Kill all sends graceful signal first, then hard kill after timeout.
- Supervisor exits only when no sessions remain and no UI clients connect, unless preference keeps daemon warm.

## Session kind behavior

### Terminal

Real live recovery.

Supervisor owns PTY and child PID. UI restores pane/tab as paused terminal. On focus/click, UI calls `attach`, replays scrollback via `read`, then subscribes to output.

### ACP

Best effort.

Persist `agent_id`, ACP `session_id`, workspace root, model/config summary, process status, and transcript/state pointers if available. If agent process still lives, reattach events. If dead, restore transcript/state where available, mark `crashed_or_unknown`, and offer resume if protocol supports load session.

### SSH/SFTP

Metadata restore only.

Restore profile ID, tabs, cwd-like metadata, and reconnect using credential store. Do not promise remote process survival unless user uses remote process persistence (`tmux`, `screen`, `nohup`). UI should say SSH restored by reconnect, not recovered live.

### Browser/editor

Restore layout and metadata. Browser reloads URL. Editor reopens files/drafts. No live process recovery.

## Failure cases

1. Normal close, no live sessions
   - supervisor exits
   - `last_shutdown=clean`
   - next launch no recovery UI

2. Normal close, live sessions, user Cancel
   - app stays open
   - no session state change

3. Normal close, live sessions, user Kill all
   - supervisor terminates process groups
   - sessions marked `exited`
   - `last_shutdown=clean`

4. Normal close, live sessions, user Keep running
   - UI exits
   - supervisor stays alive
   - `last_shutdown=keep_running`
   - next launch restores paused attachable terminals

5. Renderer/Tauri crash or forced kill
   - supervisor heartbeat detects client gone
   - child CLI continues
   - `last_shutdown=crashed_or_unknown`
   - next launch shows recovery banner and paused terminals

6. Supervisor crash
   - child survival depends OS/process group
   - registry has stale `supervisor_pid`
   - next launch marks affected sessions `lost`
   - scrollback journal visible; restart offered

## Testing plan

Rust unit tests:

- registry schema migration
- atomic writes
- stale heartbeat classification
- `last_shutdown=clean`
- `last_shutdown=keep_running`
- `last_shutdown=crashed_or_unknown`

Supervisor integration tests:

- spawn long-running CLI (`sleep` or echo loop)
- kill fake UI client
- verify child PID remains alive
- relaunch fake UI and attach
- verify scrollback replay and live output

Renderer tests:

- recovery banner
- paused terminal card
- close modal: Keep running / Kill all / Cancel
- lost session state
- SSH reconnect copy

Contract tests:

- IPC request serialization
- IPC event serialization
- protocol version mismatch handling

Manual smoke:

- run long CLI
- force kill Termul
- relaunch
- attach
- verify process still running and output intact

## Implementation notes

Likely phased rollout:

1. Add registry model and recovery state classifier behind tests.
2. Add `termul-supervisor` crate/bin with IPC skeleton.
3. Move PTY spawn/write/resize/kill/read path behind supervisor adapter.
4. Add paused attach UX and recovery banner.
5. Add shutdown modal and `last_shutdown` transitions.
6. Extend ACP/SSH/browser/editor restore metadata.
7. Harden supervisor crash/lost-session handling.
