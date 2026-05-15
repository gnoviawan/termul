# ADR: Persistent PTY Daemon For Full Terminal Session Continuity

- **Status:** Proposed
- **Date:** 2026-05-13
- **Decision Type:** Architecture Decision Record
- **Owners:** Termul runtime / terminal subsystem
- **Related:** `docs/terminal-pty-daemon-proposal.md`

## Context

Termul currently manages PTY sessions inside main Tauri app process.

Current architecture gives good continuity only while app process stays alive:
- project switching can preserve live PTYs in memory
- renderer panes can detach/reattach while runtime still alive
- transcripts and scrollback can be replayed into xterm

But full app exit breaks continuity.

### Current blocking behavior

On app exit, Rust runtime executes global PTY cleanup:
- `src-tauri/src/lib.rs`
- `RunEvent::ExitRequested`
- `pty_manager.kill_all().await`

Result:
- all child PTYs terminate
- interactive tools like `pi`, `claudecode`, dev servers, shells, and TUIs are lost
- restart can only restore shell/cwd/layout/history snapshots
- restart cannot restore live process state

### Product requirement behind this ADR

Need true continuity across full app close/reopen:
- close Termul app
- keep terminal work alive
- reopen Termul later
- reconnect to same long-running PTY sessions

Examples:
- `pi`
- `claudecode`
- `npm run dev`
- long-running shell/TUI workflows

## Decision

Adopt persistent PTY daemon architecture.

Create new background runtime component, tentatively named `termul-ptyd`, responsible for owning PTY sessions outside main Tauri app process.

Main Tauri app becomes session client and UI shell.

### Decision summary

- PTY lifecycle moves out of main Tauri app process
- app exit must no longer imply PTY termination by default
- terminal sessions get stable daemon-owned `sessionId`
- renderer/store terminal identity stays separate from daemon session identity
- reopen flow reconnects to daemon sessions instead of spawning fresh shells when possible

## Why this decision

### Rejected simpler approaches

#### 1. Transcript restore only
Not enough.

It restores appearance only:
- shell text
- some output history
- some cwd context

It does **not** restore:
- interactive process state
- in-memory prompt/tool context
- live TUI state

#### 2. Replay last command on restore
Useful fallback, not sufficient.

It can make UX feel resumed for safe commands, but it is still not same session.
It cannot guarantee continuity for:
- interactive agents
- long-running jobs
- partially completed prompts
- shell-local state

#### 3. Keep PTY inside Tauri app and stop killing on close
Insufficient for full app exit/restart requirement.

This helps only when app hides to background or window detaches while process stays alive.
It does not survive real app process exit.

## Consequences

### Positive

- real terminal session continuity across full app restart
- long-running PTY tools can remain alive
- renderer can reconnect after crash/restart/update
- future features like session browser, background jobs, and cross-window attach become easier

### Negative

- much higher system complexity
- new IPC protocol needed
- cross-platform packaging complexity rises
- security model needed for local daemon comms
- protocol versioning needed between app and daemon
- resource/orphan cleanup becomes separate subsystem concern

## Scope Of Change

This ADR affects:

### Rust runtime
- `src-tauri/src/pty/manager.rs`
- `src-tauri/src/lib.rs`
- terminal command bridge
- app exit semantics
- process ownership model

### Renderer
- terminal API adapters
- restore hooks
- terminal store identity model
- session recovery behavior

### Packaging / release
- sidecar/daemon bundling
- daemon startup policy
- daemon version compatibility with app builds

## Non-Goals

This ADR does **not** require in first phase:
- multi-user shared session support
- remote terminal hosting
- network-accessible PTY API
- cross-device session sync
- perfect TUI snapshot virtualization independent of live PTY

## Chosen Model

### Ownership model

#### Main app owns
- window lifecycle
- workspace and tab state
- editor/browser/project UX
- user actions on sessions
- attach/detach requests

#### Daemon owns
- PTY process lifecycle
- session registry
- backlog buffering
- runtime metadata
- attach count tracking
- detached/orphan session cleanup policy

### Identity model

Need two IDs:
- `terminalId` — app/store/workspace identity
- `sessionId` — daemon PTY identity

These must remain separate.

## Transport Decision

Preferred local IPC transport:
- Windows: named pipe
- macOS/Linux: unix domain socket

Reason:
- local-only communication
- good performance
- smaller security surface than open TCP

TCP with auth token may exist as fallback, but not preferred baseline.

## Security Decision

Daemon communication must require local auth handshake.

Minimum expected:
- daemon generates per-user auth token
- token stored in app data dir with restricted permissions
- app reads token and uses it in handshake
- daemon rejects unauthenticated clients

## Exit Semantics Decision

Default app close/quit should detach from daemon sessions, not kill them.

Explicit termination must remain available via separate user action, such as:
- `Quit and Terminate Sessions`
- session-level `Kill`
- daemon-level `Kill All Sessions`

## Restore Semantics Decision

On app boot:
1. app connects to daemon
2. app queries sessions
3. app loads persisted workspace/session mapping
4. app picks resume candidate for active project
5. app attaches terminal UI to daemon session
6. daemon streams backlog then live output

Fallback order:
1. existing daemon session mapped to saved active terminal
2. newest daemon session for project still running
3. daemon session with matching project/terminal metadata
4. fresh terminal spawn

## Implementation Strategy

### Phase 0 — refactor for separation
- extract reusable PTY session core from current `PtyManager`
- isolate app-owned logic from PTY runtime logic
- introduce session identity in shared contracts

### Phase 1 — daemon MVP
- add `termul-ptyd`
- support one-session spawn/attach/detach/kill
- keep session alive after app exit
- reopen app and reattach to same session

### Phase 2 — project-aware restore
- persist terminal-to-session mapping
- restore active project and active terminal session
- attach correct pane/tab on reopen

### Phase 3 — hardening
- orphan cleanup
- protocol versioning
- crash recovery
- daemon stale-state cleanup
- updater compatibility behavior

## Alternatives Considered

### Alternative A — close-to-background only
Pros:
- cheaper
- faster to implement
- likely sufficient for many users

Cons:
- not true restart continuity
- fails explicit exit/reboot/update scenarios

Decision:
- good short-term UX improvement
- not enough for full requirement

### Alternative B — command replay allowlist
Pros:
- cheap
- works for some tools

Cons:
- not true continuity
- can be dangerous if replay broadens
- cannot preserve in-memory state

Decision:
- valid fallback feature
- not chosen as primary solution

## Risks Accepted

By choosing daemon model, project accepts:
- larger architecture surface
- longer implementation time
- more packaging and release complexity
- need for protocol evolution discipline

## Follow-up Required

Before implementation PRs:
1. protocol spec document
2. daemon lifecycle document
3. packaging plan for sidecar/daemon builds
4. session/orphan cleanup policy

## Decision Outcome

**Proposed:** adopt persistent PTY daemon architecture as long-term solution for true terminal session continuity across full app exit and reopen.

Until implemented, existing snapshot/session restore remains fallback-only and should not be described as full live session persistence.