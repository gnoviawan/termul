# Terminal PTY Daemon Proposal

**Status:** Proposal  
**Date:** 2026-05-13  
**Scope:** Terminal session persistence across full app exit / restart  
**Target repo:** Termul Manager

## Goal

Allow terminal work to survive full Termul app shutdown and later app restart.

Desired user outcome:

- close Termul app
- `pi`, `claudecode`, `npm run dev`, shells, TUIs keep running
- reopen Termul
- reconnect to same terminal sessions with prior output and active tab selection

## Current State

Current architecture cannot restore terminal process state after app exit.

### What exists today

Renderer side:
- terminal layout persistence via `useTerminalAutoSave.ts`
- session persistence via `use-session-recovery.ts` and `tauri-session-api.ts`
- live-PTY reuse during project switches while app still alive via `use-terminal-restore.ts`
- detached transcript capture via `use-terminal-detached-output.ts`

Rust side:
- `PtyManager` owns PTY lifecycle in `src-tauri/src/pty/manager.rs`
- renderer attachment tracking via `renderer_refs`
- orphan detection support
- PTY spawn/write/resize/kill commands exposed through Tauri IPC

### Current hard stop

`src-tauri/src/lib.rs` handles app exit with:

- `pty_manager.kill_all().await`
- then app exit

Meaning:
- full app exit kills all PTY children
- process state is lost
- renderer can only restore shell/cwd/history snapshot, not live session state

## Problem Statement

Project switch continuity exists only while Tauri app process remains alive.

It does **not** survive:
- explicit quit
- window destroy followed by app exit
- dev restart that tears down Tauri backend
- updater restart
- crash of main app process

To achieve full continuity, PTY ownership must move outside main Tauri app process.

## Proposed Architecture

Introduce persistent background PTY daemon:

- new binary: `termul-ptyd`
- daemon owns PTY sessions
- Tauri app becomes client/UI only
- UI attaches/detaches from daemon-managed sessions
- app exit no longer implies PTY kill

## High-Level Model

```text
+-----------------------+
| Termul Renderer       |
| React + Zustand       |
+-----------+-----------+
            |
            | Tauri invoke / local IPC bridge
            v
+-----------------------+
| Termul Tauri App      |
| window/menu/adapters  |
+-----------+-----------+
            |
            | local socket / named pipe
            v
+-----------------------+
| termul-ptyd           |
| session registry      |
| PTY spawn/read/write  |
| backlog buffer        |
+-----------+-----------+
            |
            v
+-----------------------+
| shell / pi / TUI app  |
+-----------------------+
```

## Responsibilities Split

### Tauri app keeps
- window lifecycle
- menu / tray / updater
- renderer-host bridge
- project/workspace/editor/browser state
- user-triggered attach/detach/kill commands

### PTY daemon owns
- PTY process lifecycle
- per-session identity and metadata
- stdout/stderr backlog buffering
- renderer client subscriptions
- orphan session policy
- attach/detach state
- optional idle cleanup policy

## Session Model

Each daemon session should track at minimum:

- `sessionId: string`
- `projectId?: string`
- `terminalId?: string`
- `shell: string`
- `cwd?: string`
- `env?: Record<string, string>`
- `pid: u32`
- `createdAt`
- `lastActivityAt`
- `lastAttachedAt`
- `attachedClientCount`
- `backlog` or transcript ring buffer
- `cols`, `rows`
- `status: running | exited | dead`
- `exitCode?: number`
- `name?: string`

Important distinction:
- `terminalId` = renderer/store identity
- `sessionId` = daemon PTY identity

Do not overload one as other.

## Proposed IPC Surface

### App ↔ daemon commands

#### Session lifecycle
- `create_session`
- `list_sessions`
- `get_session`
- `attach_session`
- `detach_session`
- `kill_session`
- `kill_all_sessions`
- `prune_orphans`

#### PTY interaction
- `write_session`
- `resize_session`
- `read_backlog`

#### Metadata / persistence
- `set_session_project`
- `set_session_terminal_mapping`
- `get_sessions_for_project`
- `get_resume_candidates`

### Events / stream
- `session-data`
- `session-exit`
- `session-cwd-changed`
- `session-git-branch-changed`
- `session-git-status-changed`
- `session-exit-code-changed`
- `session-attached-count-changed`

## Transport Options

### Windows
- named pipe preferred

### macOS / Linux
- unix domain socket preferred

### Cross-platform fallback
- localhost TCP with random auth token file

### Recommendation
Use:
- named pipes on Windows
- unix sockets on macOS/Linux

Reason:
- local only
- low overhead
- better security than open TCP

## Authentication / Trust

Daemon must reject arbitrary local clients.

Recommended:
- generate per-user auth token on daemon boot
- store token in user app data dir with user-only permissions
- Tauri app reads token and includes it in first handshake
- daemon rejects unauthenticated clients

Optional later:
- include app version / protocol version in handshake

## Backlog / Output Strategy

Need backlog so reopened renderer can redraw prior terminal output.

### Recommendation
Keep ring buffer per session with:
- raw PTY bytes or normalized UTF-8 chunks
- size cap, example 1–5 MB per session configurable

Use raw-ish stream form, not line-only.

Reason:
- better xterm fidelity
- supports TUIs better than line snapshots

Still keep renderer transcript fallback if needed, but daemon backlog becomes source of truth after reconnect.

## Restore Flow

### On normal app boot
1. Tauri app starts
2. app connects to daemon
3. app asks daemon for sessions
4. app loads saved project/workspace/session mapping
5. app chooses resume candidate for active project
6. renderer mounts terminal pane
7. app attaches pane to daemon session
8. daemon sends backlog
9. daemon continues live stream

### On project switch
1. renderer detaches terminal pane
2. daemon session stays alive
3. switch to another project
4. switching back reattaches same session

### On app quit
1. renderer detaches all sessions
2. Tauri app exits
3. daemon stays alive
4. sessions continue running

### On explicit "Quit and terminate sessions"
1. app calls daemon `kill_all_sessions`
2. daemon kills PTYs
3. app exits

## Resume Selection Rules

Recommended order:

1. session mapped to saved `activeTerminalId` for project
2. session mapped to project and marked `lastAttachedAt` newest
3. session mapped to project with `attachedClientCount === 0` and still running
4. fallback to spawn fresh shell

## Mapping Persistence

Need durable mapping between project/workspace state and daemon session IDs.

Persist at least:
- `projectId -> activeSessionId`
- `terminalId -> sessionId`
- `sessionId -> metadata snapshot`

Can live in existing store persistence layer or daemon-owned state file.

### Recommendation
Split ownership:
- app persists `projectId`, `terminalId`, pane layout, active tab
- daemon persists `sessionId`, process metadata, backlog, runtime status

## Required Refactors In Current Repo

### Rust

#### New crate/module surface
Add something like:
- `src-tauri/src/pty_daemon/`
- or new binary crate under `src-tauri/src/bin/termul-ptyd.rs`

#### Current `PtyManager`
Refactor so core session logic becomes reusable by:
- main app today
- daemon tomorrow

Likely split `PtyManager` into:
- `PtySessionRegistry`
- `PtySession`
- `PtyEventBroadcaster`
- `DaemonServer`

#### Exit behavior
Current `kill_all()` on app exit must move behind explicit shutdown mode, not default exit.

### Renderer / app adapters
New adapter layer likely needed:
- `src/renderer/lib/pty-session-api.ts`
- `src/renderer/lib/tauri-pty-session-api.ts`

This should replace direct assumption that Tauri app itself owns PTY.

### Store changes
Terminal records need new field(s):
- `sessionId?: string`
- maybe `resumeState?: 'live' | 'replayed' | 'fresh'`

### Restore hooks
Update:
- `use-terminal-restore.ts`
- `useTerminalAutoSave.ts`
- `use-session-recovery.ts`

So they prefer daemon sessions over shell respawn.

## Migration Strategy

### Phase 0 — prep refactor
- extract PTY session abstractions from current `PtyManager`
- define session identity separate from terminal store identity
- add session metadata fields in shared contracts

### Phase 1 — in-app detachable session registry
- keep PTY inside main app still
- refactor to explicit attach/detach APIs
- build backlog source in Rust side
- no daemon yet

### Phase 2 — sidecar daemon MVP
- start `termul-ptyd` from app
- spawn PTY in daemon
- attach one renderer terminal to one daemon session
- verify close app / reopen app reconnect works

### Phase 3 — project/session restore integration
- persist terminalId ↔ sessionId mapping
- restore active project and active terminal session
- rebuild tabs around daemon sessions

### Phase 4 — production hardening
- orphan timeout
- stale daemon recovery
- crash restart handling
- daemon upgrade/version handling
- kill semantics and UX

## MVP Recommendation

Do **not** start with full multi-project orchestration.

Start smallest:
- daemon can spawn one PTY session
- app can attach/detach
- app exit leaves daemon alive
- app relaunch reattaches same session
- backlog replay works

Success criteria for MVP:
- run `pi`
- close app
- reopen app
- same `pi` session still active

## UX Changes Needed

### Close behavior
Need explicit distinction:
- `Close Window` → exits UI only, sessions continue
- `Quit Termul` → exits UI only, sessions continue
- `Quit and Terminate Sessions` → kills daemon sessions and exits

Need clear copy in UI to avoid surprise background processes.

### Session status affordances
Show indicators like:
- live resumed session
- detached background session
- stale/dead session
- resumed from daemon backlog

## Risks

### 1. Complexity
This is major architecture growth.

### 2. Packaging
Need bundle sidecar/daemon correctly across OSes.

### 3. Security
Local IPC must be authenticated.

### 4. Resource leaks
Detached sessions can accumulate forever without cleanup policy.

### 5. Upgrade/version mismatch
App and daemon protocol can drift.

### 6. TUI fidelity
Backlog replay may still not perfectly reconstruct full-screen apps if attach timing or output buffering is wrong.

## Open Questions

1. Should daemon always start on app boot, or lazy-start on first terminal spawn?
2. Should daemon survive OS login session only, or auto-restart globally?
3. Should backlog be daemon-owned only, or also mirrored in renderer persistence?
4. What is orphan timeout default for detached sessions?
5. Should quit default preserve sessions, or terminate them?
6. How should updater behave if daemon is running older protocol?
7. How should snapshots interact with daemon sessions?

## Recommendation

Proceed only if product requirement is true session continuity across app restarts.

If yes:
- approve Phase 0 + Phase 1 refactor first
- do not jump straight to full daemon implementation in one PR
- treat daemon as separate subsystem with protocol/versioning discipline

If no:
- simpler `close-to-background` model likely achieves most user value cheaper

## Proposed Deliverables

### Deliverable A — ADR / decision
Formal architectural decision adopting daemon-backed PTY persistence.

### Deliverable B — shared protocol spec
Message schema for app ↔ daemon session IPC.

### Deliverable C — Phase 0 refactor PR
Extract reusable PTY session core from current app-owned `PtyManager`.

### Deliverable D — daemon MVP PR
One-session detach/reattach working end-to-end.

## Suggested Follow-up Files

- `docs/adr-terminal-pty-daemon.md`
- `docs/terminal-pty-daemon-protocol.md`
- `docs/terminal-session-lifecycle.md`

## Bottom Line

To restore terminal progress **utuh** after full app exit:

- current app-owned PTY model is insufficient
- command replay is not enough
- persistent daemon ownership is correct long-term design

This proposal recommends daemon-backed PTY sessions with attach/detach semantics, backlog replay, and durable session mapping as phased work.