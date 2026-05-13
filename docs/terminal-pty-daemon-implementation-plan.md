# Terminal PTY Daemon Implementation Plan

**Status:** Planning  
**Date:** 2026-05-13  
**Related:**
- `docs/terminal-pty-daemon-proposal.md`
- `docs/adr-terminal-pty-daemon.md`
- `docs/terminal-pty-daemon-protocol.md`

## Goal

Implement daemon-backed PTY persistence in phased, low-risk steps.

Primary product goal:
- close Termul app
- reopen later
- reconnect to same running PTY sessions

## Success Criteria

### Final success
- full app exit does not kill daemon-owned PTYs by default
- reopened app restores active project and active terminal session
- `pi`, `claudecode`, and shells remain attached to same live PTY when possible
- daemon sessions can be explicitly terminated by user

### MVP success
- single daemon-managed PTY session survives app exit
- app reconnects after relaunch
- backlog replay + live stream both work

## Constraints

- current codebase is Tauri-first and monolithic
- current PTY ownership lives in `src-tauri/src/pty/manager.rs`
- app exit currently kills all PTYs in `src-tauri/src/lib.rs`
- renderer restore logic assumes app-owned PTY lifecycle
- change must preserve testability and strict TS/Rust structure

## Implementation Principles

- do not rewrite terminal stack in one pass
- first isolate ownership boundaries
- keep renderer API facades stable where possible
- introduce daemon protocol as additive layer
- ship minimal reconnect path before broader UX changes

## Work Breakdown

---

## Phase 0 — Prep And Isolation

### Objective
Refactor current PTY subsystem so daemon extraction is possible without changing user-facing behavior yet.

### Deliverables
- reusable PTY session core split from app-specific Tauri wiring
- explicit session identity model
- renderer/store contracts updated for future `sessionId`
- tests proving no regression in current app-owned PTY mode

### Rust tasks

#### 0.1 Extract PTY session primitives
Current file:
- `src-tauri/src/pty/manager.rs`

Target split candidates:
- `src-tauri/src/pty/session.rs`
- `src-tauri/src/pty/session_registry.rs`
- `src-tauri/src/pty/events.rs`
- `src-tauri/src/pty/manager.rs` as app integration wrapper

Move into reusable core:
- PTY spawn
- PTY read/write/resize/kill
- per-session metadata
- renderer/client attachment count semantics
- event emission abstraction
- orphan metadata

Keep app-owned wrapper responsibilities temporary:
- Tauri `AppHandle` event bridge
- current invoke command integration

#### 0.2 Introduce `sessionId`
Current app uses `terminalId` and `ptyId`.

Need new shared conceptual model:
- `terminalId` = renderer/store/workspace identity
- `ptyId` = current app-owned PTY identifier
- `sessionId` = future daemon-owned identifier

Initial step:
- add `sessionId?: string` where needed in renderer terminal domain model
- do not require daemon yet

### Renderer tasks

#### 0.3 Extend terminal model for future daemon linkage
Files likely touched:
- `src/renderer/types/project.ts`
- `src/renderer/stores/terminal-store.ts`
- terminal persistence/session type surfaces

Add fields like:
- `sessionId?: string`
- maybe `restoreMode?: 'daemon' | 'app-pty' | 'fresh'`

#### 0.4 Preserve API seam
Files:
- `src/renderer/lib/terminal-api.ts`
- `src/renderer/lib/tauri-terminal-api.ts`

Goal:
- keep existing terminal UI mostly unchanged
- prepare future alternate adapter backed by daemon session API

### Validation
- current app still works with app-owned PTY path
- terminal spawn/write/resize/kill unchanged
- no user-facing behavior change yet

### Risk
Low-to-medium. Mostly structural refactor.

---

## Phase 1 — Daemon Skeleton

### Objective
Create standalone daemon binary with local IPC handshake, auth, and empty session registry.

### Deliverables
- `termul-ptyd` binary starts
- local transport works
- app can handshake with daemon
- protocol version/auth enforced

### Rust tasks

#### 1.1 Add daemon binary
Likely location:
- `src-tauri/src/bin/termul-ptyd.rs`

Responsibilities:
- boot local IPC server
- create auth token
- initialize session registry
- expose protocol v1 commands

#### 1.2 Add transport layer
Suggested files:
- `src-tauri/src/pty_daemon/transport.rs`
- `src-tauri/src/pty_daemon/server.rs`
- `src-tauri/src/pty_daemon/protocol.rs`
- `src-tauri/src/pty_daemon/auth.rs`

Support:
- Windows named pipe
- macOS/Linux unix socket

#### 1.3 Daemon auth/token bootstrap
Persist token to app data path.

Need helper for:
- create token if absent
- rotate token if desired later
- ensure file permissions restricted

### App tasks

#### 1.4 Add daemon client adapter
New files likely:
- `src/renderer/lib/pty-session-api.ts`
- `src/renderer/lib/tauri-pty-session-api.ts`

Temporary methods:
- `hello`
- `listSessions`
- `getSession`

### Packaging tasks

#### 1.5 Bundle daemon binary
Likely config changes:
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.conf.prod.json`
- maybe Cargo/bin setup

### Validation
- daemon process launches in dev/prod
- app handshake succeeds
- protocol mismatch failure readable
- auth failure handled cleanly

### Risk
Medium. Cross-platform local IPC and packaging risk starts here.

---

## Phase 2 — Single Session MVP

### Objective
Prove one PTY session can be created in daemon, survive app exit, and reconnect on relaunch.

### Deliverables
- daemon can spawn PTY session
- renderer can attach/detach
- app exit does not kill daemon session
- reopen reattaches same session

### Rust tasks

#### 2.1 Implement session registry
Daemon side commands:
- `create-session`
- `list-sessions`
- `attach-session`
- `detach-session`
- `write-session`
- `resize-session`
- `kill-session`
- `read-backlog`

#### 2.2 Move PTY ownership to daemon for MVP path
Daemon owns:
- `portable-pty` objects
- child process handles
- stdout read loop
- backlog buffer
- session metadata

#### 2.3 Backlog buffer
Implement ring buffer per session.

MVP target:
- size-capped raw UTF-8 chunk backlog
- enough for xterm replay after reconnect

### Renderer tasks

#### 2.4 Alternate terminal attach path
Files likely touched:
- `src/renderer/components/terminal/ConnectedTerminal.tsx`
- terminal facade layer

Behavior:
- if terminal has `sessionId`, connect via daemon adapter
- else use legacy app-owned PTY path

#### 2.5 Terminal record creation with session mapping
When terminal created through daemon path:
- store `sessionId`
- store shell/cwd/project linkage

### App lifecycle tasks

#### 2.6 Stop killing daemon PTYs on app exit
Critical change:
- `src-tauri/src/lib.rs`

Need split exit behavior:
- app-owned PTYs may still kill
- daemon-owned PTYs must not kill on default exit

For MVP, simplest path:
- app stops invoking kill for daemon sessions
- app only detaches

### Validation
Manual golden path:
1. create one terminal backed by daemon
2. run `pi`
3. close app fully
4. reopen app
5. same session reconnects

### Risk
High. This is first user-visible persistence milestone.

---

## Phase 3 — Project-Aware Restore

### Objective
Integrate daemon sessions with existing project/workspace restore model.

### Deliverables
- saved project opens correct daemon session
- active terminal selection restored correctly
- pane tab mapped to correct session

### Renderer tasks

#### 3.1 Persist terminalId ↔ sessionId mapping
Files likely touched:
- `src/renderer/hooks/useTerminalAutoSave.ts`
- persistence types
- maybe session recovery types

Need persist:
- `terminalId`
- `sessionId`
- `projectId`
- active terminal selection

#### 3.2 Update restore path
Files:
- `src/renderer/hooks/use-terminal-restore.ts`
- `src/renderer/hooks/use-crash-recovery.ts`
- maybe `use-editor-persistence.ts`

New restore order:
1. daemon resume candidate for active project + active terminal
2. attach existing daemon session
3. fallback persisted replay
4. fallback default shell

#### 3.3 Workspace tab reconciliation
Files:
- `src/renderer/stores/workspace-store.ts`
- `src/renderer/components/workspace/PaneContent.tsx`

Need correct reopen of terminal tab backed by daemon session.

### Validation
- multi-project switch with daemon sessions
- app close/reopen on same project
- restore active terminal tab, not random shell

### Risk
Medium. Mostly restore orchestration complexity.

---

## Phase 4 — Exit UX And Session Controls

### Objective
Expose correct user controls for preserving vs terminating sessions.

### Deliverables
- explicit quit modes
- session management affordances
- detached session visibility

### UX tasks

#### 4.1 Distinguish close modes
Need app commands:
- `Close Window`
- `Quit Termul`
- `Quit and Terminate Sessions`

Need exact semantics documented.

#### 4.2 Session status UI
Possible places:
- terminal tab badges
- status bar
- command palette
- preferences panel

Show:
- live daemon session
- detached session
- dead session
- reattached session

#### 4.3 Session management actions
Potential actions:
- reconnect session
- kill session
- kill all background sessions
- prune orphans now

### Validation
- users understand background sessions remain alive
- explicit destructive action required to kill all

### Risk
Medium UX/product risk if semantics unclear.

---

## Phase 5 — Hardening And Production Readiness

### Objective
Make daemon path robust enough for production release.

### Deliverables
- stale session cleanup
- protocol compatibility checks
- daemon crash recovery behavior
- updater handling
- telemetry/logging

### Tasks

#### 5.1 Orphan cleanup policy
Daemon should prune sessions by configurable rules:
- detached for too long
- exited long ago
- invalid metadata

#### 5.2 Crash recovery
If daemon dies:
- app should detect disconnect
- mark sessions lost/dead
- offer respawn or restart daemon

#### 5.3 Protocol compatibility
Need behavior when app and daemon protocol differ:
- refuse with readable error
- optionally restart daemon if safe

#### 5.4 Updater / install behavior
Need rules for:
- app update while daemon alive
- daemon binary replacement
- restart ordering

#### 5.5 Logging / diagnostics
Need diagnostic visibility for:
- session attach/detach
- daemon auth
- protocol mismatch
- orphan pruning
- backlog truncation

### Validation
- production build package test on Windows/macOS/Linux
- reconnect after update path tested
- background daemon leak scenarios tested

### Risk
High operational complexity, but mostly after core functionality works.

## File Impact Map

### Likely Rust files touched
- `src-tauri/src/lib.rs`
- `src-tauri/src/pty/manager.rs`
- `src-tauri/src/pty/mod.rs`
- new `src-tauri/src/pty_daemon/*`
- new `src-tauri/src/bin/termul-ptyd.rs`
- possibly `src-tauri/Cargo.toml`

### Likely renderer files touched
- `src/renderer/lib/terminal-api.ts`
- `src/renderer/lib/tauri-terminal-api.ts`
- new `src/renderer/lib/pty-session-api.ts`
- new `src/renderer/lib/tauri-pty-session-api.ts`
- `src/renderer/components/terminal/ConnectedTerminal.tsx`
- `src/renderer/hooks/use-terminal-restore.ts`
- `src/renderer/hooks/useTerminalAutoSave.ts`
- `src/renderer/hooks/use-session-recovery.ts`
- `src/renderer/stores/terminal-store.ts`
- `src/renderer/types/project.ts`

### Likely config/docs files touched
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.conf.prod.json`
- release/deployment docs
- API contract docs
- architecture docs

## Testing Plan

### Unit tests
- daemon protocol parsing
- auth token validation
- session registry behavior
- resume candidate scoring
- renderer restore precedence

### Integration tests
- create session → attach → write → detach
- attach after app relaunch mock
- backlog replay correctness
- orphan cleanup behavior

### Manual tests
- run `pi`
- close app
- reopen app
- confirm same live prompt

- run `claudecode`
- detach by closing app
- reopen app
- continue same session

- run `npm run dev`
- reopen app
- see same running server terminal

## Suggested Milestones

### Milestone 1
Phase 0 merged.

### Milestone 2
Daemon boot + handshake merged.

### Milestone 3
Single-session reconnect MVP works.

### Milestone 4
Project-aware restore works for daemon sessions.

### Milestone 5
UX + hardening complete.

## Recommendation

Start with:
1. Phase 0
2. Phase 1
3. Phase 2 single-session MVP

Do not attempt multi-project restore and full UX redesign before single-session reconnect proves stable.

## Bottom Line

Most valuable path:
- first make daemon path technically possible
- then prove one live session survives app exit
- only after that integrate deeply with project/workspace restoration