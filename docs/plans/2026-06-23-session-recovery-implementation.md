# Session Recovery Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build Termul session recovery so workspace state restores after bad shutdown and local terminal sessions can survive UI exit through a durable supervisor path.

**Architecture:** Implement this as phased strangler migration. First add tested recovery registry + renderer recovery contracts without changing PTY ownership. Then add supervisor IPC skeleton and adapter seams. Final phases move terminal process ownership from `PtyManager` to `termul-supervisor` behind existing Tauri commands so renderer API stays stable.

**Tech Stack:** Rust/Tauri 2, `serde`, `tokio`, `portable-pty`, React 18, TypeScript strict, Zustand, Vitest, Rust unit/integration tests.

---

## Notes before starting

- User chose no separate git worktree; implement directly on current fork/branch.
- Existing design doc: `docs/plans/2026-06-23-session-recovery-design.md`.
- Preserve existing IPC shape where possible: Rust commands in `src-tauri/src/commands.rs`, renderer adapter in `src/renderer/lib/tauri-terminal-api.ts`, shared contracts in `src/shared/types/ipc.types.ts`.
- Do not do full PTY move in first commit. Start with recovery registry, contracts, and UX state; then swap process owner behind same APIs.
- Run focused tests after each task, full gates before PR:
  - `bun run ci`
  - `bun run typecheck`
  - `bun run test`
  - `cd src-tauri && cargo clippy --all-targets -- -D warnings`
  - `cd src-tauri && cargo test`

---

## Task 1: Rust recovery registry model

**Files:**
- Create: `src-tauri/src/session_recovery/mod.rs`
- Create: `src-tauri/src/session_recovery/registry.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/session_recovery/registry.rs`

**Step 1: Create module shell**

Add `src-tauri/src/session_recovery/mod.rs`:

```rust
pub mod registry;
```

Modify `src-tauri/src/lib.rs` near other modules:

```rust
mod session_recovery;
```

**Step 2: Write failing tests for registry classification**

In `src-tauri/src/session_recovery/registry.rs`, add types and tests first. Tests should cover:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_shutdown_stays_clean() {
        let registry = SessionRegistry::new(123);
        assert_eq!(registry.classify_startup(123, 1_000), StartupRecoveryState::Clean);
    }

    #[test]
    fn keep_running_restores_attachable_sessions() {
        let mut registry = SessionRegistry::new(123);
        registry.last_shutdown = LastShutdown::KeepRunning;
        assert_eq!(registry.classify_startup(123, 1_000), StartupRecoveryState::KeepRunning);
    }

    #[test]
    fn stale_heartbeat_after_unknown_shutdown_is_crashed_or_unknown() {
        let mut registry = SessionRegistry::new(123);
        registry.last_shutdown = LastShutdown::CrashedOrUnknown;
        registry.last_heartbeat_at_ms = 1_000;
        assert_eq!(registry.classify_startup(123, 10_000), StartupRecoveryState::CrashedOrUnknown);
    }

    #[test]
    fn dead_supervisor_marks_running_terminal_lost() {
        let mut registry = SessionRegistry::new(123);
        registry.sessions.push(RecoveredSession::terminal("s1", 456));
        registry.mark_lost_sessions(&|pid| pid != 456);
        assert_eq!(registry.sessions[0].status, RecoveredSessionStatus::Lost);
    }
}
```

**Step 3: Run failing Rust test**

Run:

```bash
cd src-tauri && cargo test session_recovery::registry --lib
```

Expected: FAIL because module/types missing or incomplete.

**Step 4: Implement minimal registry types**

Implement:

```rust
use serde::{Deserialize, Serialize};

pub const SESSION_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LastShutdown {
    Clean,
    KeepRunning,
    CrashedOrUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupRecoveryState {
    Clean,
    KeepRunning,
    CrashedOrUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveredSessionKind {
    Terminal,
    Acp,
    Ssh,
    Browser,
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveredSessionStatus {
    Running,
    Exited,
    Detached,
    Lost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredSession {
    pub session_id: String,
    pub kind: RecoveredSessionKind,
    pub status: RecoveredSessionStatus,
    pub pid: Option<u32>,
    pub process_group_id: Option<u32>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub scrollback_journal_path: Option<String>,
    pub exit_code: Option<i32>,
    pub recovery_reason: Option<String>,
}

impl RecoveredSession {
    #[cfg(test)]
    fn terminal(session_id: &str, pid: u32) -> Self {
        Self {
            session_id: session_id.to_string(),
            kind: RecoveredSessionKind::Terminal,
            status: RecoveredSessionStatus::Running,
            pid: Some(pid),
            process_group_id: Some(pid),
            command: None,
            args: Vec::new(),
            shell: None,
            cwd: None,
            cols: None,
            rows: None,
            scrollback_journal_path: None,
            exit_code: None,
            recovery_reason: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRegistry {
    pub schema_version: u32,
    pub supervisor_pid: u32,
    pub last_shutdown: LastShutdown,
    pub last_heartbeat_at_ms: u64,
    pub sessions: Vec<RecoveredSession>,
}

impl SessionRegistry {
    pub fn new(supervisor_pid: u32) -> Self {
        Self {
            schema_version: SESSION_REGISTRY_SCHEMA_VERSION,
            supervisor_pid,
            last_shutdown: LastShutdown::Clean,
            last_heartbeat_at_ms: 0,
            sessions: Vec::new(),
        }
    }

    pub fn classify_startup(&self, current_supervisor_pid: u32, _now_ms: u64) -> StartupRecoveryState {
        match self.last_shutdown {
            LastShutdown::Clean => StartupRecoveryState::Clean,
            LastShutdown::KeepRunning => StartupRecoveryState::KeepRunning,
            LastShutdown::CrashedOrUnknown => {
                if self.supervisor_pid == current_supervisor_pid {
                    StartupRecoveryState::CrashedOrUnknown
                } else {
                    StartupRecoveryState::CrashedOrUnknown
                }
            }
        }
    }

    pub fn mark_lost_sessions(&mut self, is_pid_alive: &impl Fn(u32) -> bool) {
        for session in &mut self.sessions {
            if session.status == RecoveredSessionStatus::Running {
                if let Some(pid) = session.pid {
                    if !is_pid_alive(pid) {
                        session.status = RecoveredSessionStatus::Lost;
                        session.recovery_reason = Some("process_not_found".to_string());
                    }
                }
            }
        }
    }
}
```

**Step 5: Run Rust test**

Run:

```bash
cd src-tauri && cargo test session_recovery::registry --lib
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/session_recovery/mod.rs src-tauri/src/session_recovery/registry.rs
git commit -m "feat: add session recovery registry model"
```

---

## Task 2: Atomic registry persistence

**Files:**
- Modify: `src-tauri/src/session_recovery/registry.rs`
- Test: `src-tauri/src/session_recovery/registry.rs`

**Step 1: Write failing tests for save/load**

Add tests:

```rust
#[test]
fn registry_round_trips_json() {
    let dir = std::env::temp_dir().join(format!("termul-registry-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sessions.json");

    let mut registry = SessionRegistry::new(42);
    registry.last_shutdown = LastShutdown::KeepRunning;
    registry.sessions.push(RecoveredSession::terminal("term-1", 9001));

    registry.save_atomic(&path).unwrap();
    let loaded = SessionRegistry::load(&path).unwrap();

    assert_eq!(loaded.schema_version, SESSION_REGISTRY_SCHEMA_VERSION);
    assert_eq!(loaded.last_shutdown, LastShutdown::KeepRunning);
    assert_eq!(loaded.sessions[0].session_id, "term-1");

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn missing_registry_loads_empty_clean_registry() {
    let path = std::env::temp_dir().join(format!("missing-{}.json", uuid::Uuid::new_v4()));
    let loaded = SessionRegistry::load_or_new(&path, 77).unwrap();
    assert_eq!(loaded.supervisor_pid, 77);
    assert_eq!(loaded.last_shutdown, LastShutdown::Clean);
}
```

**Step 2: Run failing test**

```bash
cd src-tauri && cargo test session_recovery::registry --lib
```

Expected: FAIL because persistence methods missing.

**Step 3: Implement atomic persistence**

Add methods:

```rust
impl SessionRegistry {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let contents = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read session registry {}: {}", path.display(), e))?;
        serde_json::from_str(&contents)
            .map_err(|e| format!("failed to parse session registry {}: {}", path.display(), e))
    }

    pub fn load_or_new(path: &std::path::Path, supervisor_pid: u32) -> Result<Self, String> {
        if path.exists() {
            Self::load(path)
        } else {
            Ok(Self::new(supervisor_pid))
        }
    }

    pub fn save_atomic(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("failed to create session registry directory {}: {}", parent.display(), e)
            })?;
        }

        let tmp_path = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| format!("failed to serialize session registry: {}", e))?;
        std::fs::write(&tmp_path, bytes)
            .map_err(|e| format!("failed to write session registry temp {}: {}", tmp_path.display(), e))?;
        std::fs::rename(&tmp_path, path)
            .map_err(|e| format!("failed to replace session registry {}: {}", path.display(), e))?;
        Ok(())
    }
}
```

**Step 4: Run tests**

```bash
cd src-tauri && cargo test session_recovery::registry --lib
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src-tauri/src/session_recovery/registry.rs
git commit -m "feat: persist session recovery registry"
```

---

## Task 3: Shared renderer recovery contracts

**Files:**
- Modify: `src/shared/types/ipc.types.ts`
- Modify: `src/renderer/types/project.ts`
- Test: `src/renderer/stores/terminal-store.test.ts`

**Step 1: Add TS contract tests to existing store test**

Add assertions near terminal creation tests in `src/renderer/stores/terminal-store.test.ts`:

```ts
it('stores terminal recovery status metadata', () => {
  const terminal = useTerminalStore.getState().addTerminal('Recovered', 'p1', 'bash')

  useTerminalStore.getState().setTerminalRecoveryStatus(terminal.id, 'live_attachable')

  expect(useTerminalStore.getState().terminals.find((t) => t.id === terminal.id)?.recoveryStatus)
    .toBe('live_attachable')
})
```

**Step 2: Run failing test**

```bash
bun test src/renderer/stores/terminal-store.test.ts --run
```

Expected: FAIL because `setTerminalRecoveryStatus`/type missing.

**Step 3: Add shared types**

In `src/shared/types/ipc.types.ts` add:

```ts
export type RecoveryStatus = 'live_attachable' | 'needs_reconnect' | 'lost' | 'restored'

export type RecoveredSessionKind = 'terminal' | 'acp' | 'ssh' | 'browser' | 'editor'
export type RecoveredSessionRuntimeStatus = 'running' | 'exited' | 'detached' | 'lost'

export interface RecoveredSessionInfo {
  sessionId: string
  kind: RecoveredSessionKind
  status: RecoveredSessionRuntimeStatus
  pid?: number | null
  processGroupId?: number | null
  command?: string | null
  args: string[]
  shell?: string | null
  cwd?: string | null
  cols?: number | null
  rows?: number | null
  scrollbackJournalPath?: string | null
  exitCode?: number | null
  recoveryReason?: string | null
}
```

**Step 4: Extend terminal domain type**

In `src/renderer/types/project.ts` import and use `RecoveryStatus`:

```ts
import type { GitStatus, RecoveryStatus } from '@shared/types/ipc.types'
```

Add to `Terminal`:

```ts
recoveryStatus?: RecoveryStatus
recoveredSessionId?: string
recoveryReason?: string
```

**Step 5: Add store action**

In `src/renderer/stores/terminal-store.ts` import type and add interface action:

```ts
setTerminalRecoveryStatus: (
  id: string,
  recoveryStatus: Terminal['recoveryStatus'],
  recoveryReason?: string
) => void
```

Implement:

```ts
setTerminalRecoveryStatus: (id, recoveryStatus, recoveryReason): void => {
  set((state) => ({
    terminals: state.terminals.map((t) =>
      t.id === id ? { ...t, recoveryStatus, recoveryReason } : t
    )
  }))
},
```

**Step 6: Run test**

```bash
bun test src/renderer/stores/terminal-store.test.ts --run
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/shared/types/ipc.types.ts src/renderer/types/project.ts src/renderer/stores/terminal-store.ts src/renderer/stores/terminal-store.test.ts
git commit -m "feat: add renderer recovery status contracts"
```

---

## Task 4: Tauri recovery commands skeleton

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/shared/types/ipc.types.ts`
- Modify: `src/renderer/lib/tauri-terminal-api.ts`
- Test: `src/renderer/lib/__tests__/tauri-terminal-api.test.ts`

**Step 1: Add renderer adapter test**

In `src/renderer/lib/__tests__/tauri-terminal-api.test.ts`, add test verifying command names:

```ts
it('lists recovered sessions through Tauri IPC', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ success: true, data: [] })

  const result = await terminalApi.listRecoveredSessions()

  expect(invoke).toHaveBeenCalledWith('terminal_list_recovered_sessions')
  expect(result).toEqual({ success: true, data: [] })
})
```

Adjust import name to match current test setup (`terminalApi` may be created via factory in file).

**Step 2: Run failing test**

```bash
bun test src/renderer/lib/__tests__/tauri-terminal-api.test.ts --run
```

Expected: FAIL because API method missing.

**Step 3: Extend `TerminalApi` interface**

In `src/shared/types/ipc.types.ts`, add to `TerminalApi`:

```ts
listRecoveredSessions: () => Promise<IpcResult<RecoveredSessionInfo[]>>
```

**Step 4: Add adapter command**

In `src/renderer/lib/tauri-terminal-api.ts` add command:

```ts
LIST_RECOVERED_SESSIONS: 'terminal_list_recovered_sessions'
```

Add implementation:

```ts
async listRecoveredSessions(): Promise<IpcResult<RecoveredSessionInfo[]>> {
  return invokeIpc<RecoveredSessionInfo[]>(IPC_COMMANDS.LIST_RECOVERED_SESSIONS)
}
```

Import `RecoveredSessionInfo` type.

**Step 5: Add Rust command**

In `src-tauri/src/commands.rs`, add serializable DTO or re-export registry struct. Prefer dedicated command mapping:

```rust
#[tauri::command]
pub async fn terminal_list_recovered_sessions() -> Result<IpcResult<Vec<crate::session_recovery::registry::RecoveredSession>>, String> {
    Ok(IpcResult::success(Vec::new()))
}
```

This returns empty until supervisor registry is wired.

Register in `invoke_handler!` in `src-tauri/src/lib.rs`.

**Step 6: Run tests**

```bash
bun test src/renderer/lib/__tests__/tauri-terminal-api.test.ts --run
cd src-tauri && cargo test terminal_list_recovered_sessions --lib
```

Expected: TS test PASS. Rust test may show 0 tests but compile PASS.

**Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/shared/types/ipc.types.ts src/renderer/lib/tauri-terminal-api.ts src/renderer/lib/__tests__/tauri-terminal-api.test.ts
git commit -m "feat: add recovery session IPC skeleton"
```

---

## Task 5: Recovery banner and paused terminal UX

**Files:**
- Search first: `rg "Terminal" src/renderer/components src/renderer/pages -g '*.tsx'`
- Modify likely: `src/renderer/components/terminal/ConnectedTerminal.tsx`
- Modify likely: pane/terminal wrapper that renders terminal tab content
- Test: create or modify closest component test (`ConnectedTerminal.test.tsx` or pane component test)

**Step 1: Locate terminal empty/error UI**

Run:

```bash
rg "healthStatus|crashed|disconnected|hibernated|pendingScrollback|restart" src/renderer/components src/renderer/hooks src/renderer/stores -n
```

Use existing health UI if present. Do not create parallel component if current terminal surface already has status cards.

**Step 2: Write failing renderer test**

Add test for terminal with `recoveryStatus: 'live_attachable'` rendering paused attach UI.

Expected copy:

```text
Session still running in background
Reconnect
```

Test should not require real Tauri runtime; mock terminal API.

**Step 3: Run failing test**

```bash
bun test src/renderer/components/terminal/ConnectedTerminal.test.tsx --run
```

Expected: FAIL because UI missing.

**Step 4: Implement minimal paused card**

In terminal component/wrapper, before opening xterm for a terminal with `recoveryStatus === 'live_attachable'`, render:

- title: `Session still running in background`
- detail: `Reconnect to replay scrollback and resume live output.`
- button: `Reconnect`

Click behavior for this task can mark status `restored`; actual supervisor attach lands later.

```ts
useTerminalStore.getState().setTerminalRecoveryStatus(terminal.id, 'restored')
```

**Step 5: Run test**

```bash
bun test src/renderer/components/terminal/ConnectedTerminal.test.tsx --run
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/renderer src/shared
git commit -m "feat: show recoverable terminal reconnect state"
```

---

## Task 6: Close modal state contract

**Files:**
- Search: `rg "close|beforeunload|onCloseRequested|exit" src/renderer src-tauri/src/lib.rs -n`
- Modify likely: `src-tauri/src/lib.rs` close handling and renderer shell/modal component
- Test: closest renderer modal/shell test

**Step 1: Locate current app close flow**

Run:

```bash
rg "CloseRequested|close_requested|preventDefault|close" src-tauri/src src/renderer -n
```

Document exact files in commit message/body if needed.

**Step 2: Write failing test**

Test state decision helper first, not full window integration. Create helper if no seam exists:

- Create: `src/renderer/lib/session-close-policy.ts`
- Test: `src/renderer/lib/session-close-policy.test.ts`

Test:

```ts
import { getSessionClosePolicy } from './session-close-policy'

it('requires prompt when live terminals exist', () => {
  expect(getSessionClosePolicy([{ status: 'running' }])).toBe('prompt')
})

it('allows close when no live sessions exist', () => {
  expect(getSessionClosePolicy([{ status: 'exited' }])).toBe('close')
})
```

**Step 3: Run failing test**

```bash
bun test src/renderer/lib/session-close-policy.test.ts --run
```

Expected: FAIL.

**Step 4: Implement helper**

```ts
type CloseSession = { status?: 'running' | 'detached' | 'exited' | 'lost' }

export function getSessionClosePolicy(sessions: CloseSession[]): 'close' | 'prompt' {
  return sessions.some((s) => s.status === 'running' || s.status === 'detached') ? 'prompt' : 'close'
}
```

**Step 5: Run test**

```bash
bun test src/renderer/lib/session-close-policy.test.ts --run
```

Expected: PASS.

**Step 6: Wire UI later, commit helper now**

```bash
git add src/renderer/lib/session-close-policy.ts src/renderer/lib/session-close-policy.test.ts
git commit -m "feat: add session close policy helper"
```

---

## Task 7: Supervisor crate/bin skeleton

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/bin/termul-supervisor.rs`
- Create: `src-tauri/src/session_recovery/ipc.rs`
- Modify: `src-tauri/src/session_recovery/mod.rs`
- Test: `src-tauri/src/session_recovery/ipc.rs`

**Step 1: Add IPC serialization tests**

In `ipc.rs` tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips() {
        let msg = SupervisorRequest::Hello {
            protocol_version: 1,
            app_instance_id: "app-1".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let decoded: SupervisorRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, msg);
    }
}
```

**Step 2: Run failing test**

```bash
cd src-tauri && cargo test session_recovery::ipc --lib
```

Expected: FAIL.

**Step 3: Implement IPC enums**

```rust
use serde::{Deserialize, Serialize};

pub const SUPERVISOR_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorRequest {
    Hello { protocol_version: u32, app_instance_id: String },
    ListSessions,
    Attach { session_id: String },
    Detach { session_id: String },
    Shutdown { kill_all: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorResponse {
    HelloAck { supervisor_pid: u32, protocol_version: u32 },
    Ok,
    Error { code: String, message: String },
}
```

Add to `mod.rs`:

```rust
pub mod ipc;
```

**Step 4: Add binary skeleton**

Create `src-tauri/src/bin/termul-supervisor.rs`:

```rust
fn main() {
    println!("termul-supervisor protocol={}", termul_manager_lib::session_recovery::ipc::SUPERVISOR_PROTOCOL_VERSION);
}
```

If `session_recovery` private blocks bin access, expose module in `lib.rs` as `pub(crate)` not enough for bin. Prefer no lib import in binary yet:

```rust
fn main() {
    println!("termul-supervisor protocol=1");
}
```

**Step 5: Run compile/tests**

```bash
cd src-tauri && cargo test session_recovery::ipc --lib && cargo build --bin termul-supervisor
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/bin/termul-supervisor.rs src-tauri/src/session_recovery/ipc.rs src-tauri/src/session_recovery/mod.rs
git commit -m "feat: add supervisor IPC skeleton"
```

---

## Task 8: Supervisor launcher seam in Tauri runtime

**Files:**
- Create: `src-tauri/src/session_recovery/supervisor.rs`
- Modify: `src-tauri/src/session_recovery/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/session_recovery/supervisor.rs`

**Step 1: Test command construction only**

Add test:

```rust
#[test]
fn supervisor_binary_name_is_stable() {
    assert_eq!(supervisor_binary_name(), "termul-supervisor");
}
```

**Step 2: Run failing test**

```bash
cd src-tauri && cargo test session_recovery::supervisor --lib
```

Expected: FAIL.

**Step 3: Implement seam**

```rust
pub fn supervisor_binary_name() -> &'static str {
    "termul-supervisor"
}

#[derive(Debug, Default)]
pub struct SupervisorClientState {
    pub supervisor_pid: Option<u32>,
}
```

Wire managed state in `lib.rs` setup:

```rust
app.manage(session_recovery::supervisor::SupervisorClientState::default());
```

**Step 4: Run test**

```bash
cd src-tauri && cargo test session_recovery::supervisor --lib
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src-tauri/src/session_recovery/supervisor.rs src-tauri/src/session_recovery/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add supervisor client state seam"
```

---

## Task 9: Registry-backed `terminal_list_recovered_sessions`

**Files:**
- Modify: `src-tauri/src/session_recovery/supervisor.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/session_recovery/supervisor.rs`

**Step 1: Add registry path/state tests**

Test pure path helper:

```rust
#[test]
fn registry_filename_is_sessions_json() {
    let base = std::path::PathBuf::from("/tmp/termul-test");
    assert_eq!(registry_path(&base), base.join("sessions.json"));
}
```

**Step 2: Implement state with registry snapshot**

Add to `SupervisorClientState`:

```rust
use parking_lot::RwLock;
use std::sync::Arc;

#[derive(Debug, Default)]
pub struct SupervisorClientState {
    pub supervisor_pid: Option<u32>,
    registry: Arc<RwLock<Option<crate::session_recovery::registry::SessionRegistry>>>,
}

impl SupervisorClientState {
    pub fn recovered_sessions(&self) -> Vec<crate::session_recovery::registry::RecoveredSession> {
        self.registry
            .read()
            .as_ref()
            .map(|r| r.sessions.clone())
            .unwrap_or_default()
    }
}

pub fn registry_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("sessions.json")
}
```

**Step 3: Update command to read state**

```rust
#[tauri::command]
pub async fn terminal_list_recovered_sessions(
    supervisor_state: State<'_, crate::session_recovery::supervisor::SupervisorClientState>,
) -> Result<IpcResult<Vec<crate::session_recovery::registry::RecoveredSession>>, String> {
    Ok(IpcResult::success(supervisor_state.recovered_sessions()))
}
```

**Step 4: Run tests**

```bash
cd src-tauri && cargo test session_recovery::supervisor --lib
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src-tauri/src/session_recovery/supervisor.rs src-tauri/src/commands.rs
git commit -m "feat: read recovered sessions from supervisor state"
```

---

## Task 10: Recovery restore orchestration in renderer

**Files:**
- Create: `src/renderer/hooks/use-session-recovery.ts`
- Test: `src/renderer/hooks/use-session-recovery.test.ts`

**Step 1: Write failing hook/helper test**

Prefer pure helper in hook file:

```ts
import { mapRecoveredTerminalToStorePatch } from './use-session-recovery'

it('maps running terminal to live attachable recovery status', () => {
  expect(
    mapRecoveredTerminalToStorePatch({
      sessionId: 's1',
      kind: 'terminal',
      status: 'running',
      args: [],
      shell: 'bash',
      cwd: '/repo'
    })
  ).toMatchObject({
    ptyId: 's1',
    recoveryStatus: 'live_attachable',
    cwd: '/repo',
    shell: 'bash'
  })
})
```

**Step 2: Run failing test**

```bash
bun test src/renderer/hooks/use-session-recovery.test.ts --run
```

Expected: FAIL.

**Step 3: Implement mapper**

```ts
import type { RecoveredSessionInfo } from '@shared/types/ipc.types'
import type { Terminal } from '@/types/project'

export function mapRecoveredTerminalToStorePatch(session: RecoveredSessionInfo): Partial<Terminal> {
  return {
    ptyId: session.sessionId,
    recoveredSessionId: session.sessionId,
    shell: session.shell ?? 'shell',
    cwd: session.cwd ?? undefined,
    lastExitCode: session.exitCode ?? null,
    recoveryStatus:
      session.status === 'running' || session.status === 'detached'
        ? 'live_attachable'
        : session.status === 'lost'
          ? 'lost'
          : 'restored',
    recoveryReason: session.recoveryReason ?? undefined
  }
}
```

**Step 4: Run test**

```bash
bun test src/renderer/hooks/use-session-recovery.test.ts --run
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/hooks/use-session-recovery.ts src/renderer/hooks/use-session-recovery.test.ts
git commit -m "feat: map recovered sessions into renderer state"
```

---

## Task 11: Replace reconnect stub with terminal attach API skeleton

**Files:**
- Modify: `src/shared/types/ipc.types.ts`
- Modify: `src/renderer/lib/tauri-terminal-api.ts`
- Modify: `src-tauri/src/commands.rs`
- Test: `src/renderer/lib/__tests__/tauri-terminal-api.test.ts`

**Step 1: Add API test**

```ts
it('attaches recovered terminal through Tauri IPC', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ success: true, data: undefined })

  const result = await terminalApi.attachRecoveredSession('s1')

  expect(invoke).toHaveBeenCalledWith('terminal_attach_recovered_session', { sessionId: 's1' })
  expect(result.success).toBe(true)
})
```

**Step 2: Add types**

In `TerminalApi`:

```ts
attachRecoveredSession: (sessionId: string) => Promise<IpcResult<void>>
```

**Step 3: Add adapter command**

`IPC_COMMANDS.ATTACH_RECOVERED_SESSION = 'terminal_attach_recovered_session'`

Implementation:

```ts
async attachRecoveredSession(sessionId: string): Promise<IpcResult<void>> {
  return invokeIpc<void>(IPC_COMMANDS.ATTACH_RECOVERED_SESSION, { sessionId })
}
```

**Step 4: Add Rust skeleton**

```rust
#[tauri::command]
pub async fn terminal_attach_recovered_session(session_id: String) -> Result<IpcResult<()>, String> {
    log::info!("[recovery] attach requested for recovered session {}", session_id);
    Ok(IpcResult::success(()))
}
```

Register in `invoke_handler!`.

**Step 5: Run tests**

```bash
bun test src/renderer/lib/__tests__/tauri-terminal-api.test.ts --run
cd src-tauri && cargo test --lib
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/shared/types/ipc.types.ts src/renderer/lib/tauri-terminal-api.ts src/renderer/lib/__tests__/tauri-terminal-api.test.ts src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add recovered terminal attach API"
```

---

## Task 12: Focused validation and plan checkpoint

**Files:**
- None unless failures require fixes.

**Step 1: Run focused validations**

```bash
bun test src/renderer/stores/terminal-store.test.ts --run
bun test src/renderer/lib/__tests__/tauri-terminal-api.test.ts --run
bun test src/renderer/hooks/use-session-recovery.test.ts --run
cd src-tauri && cargo test session_recovery --lib
```

Expected: PASS.

**Step 2: Run broader validation**

```bash
bun run typecheck
cd src-tauri && cargo test
```

Expected: PASS.

**Step 3: Fix failures with smallest changes**

If any fail, do not widen scope. Fix compile/type/test issues only.

**Step 4: Commit validation fixes if needed**

```bash
git add <fixed-files>
git commit -m "fix: stabilize session recovery scaffolding"
```

---

## Post-plan implementation phases not included here

This plan intentionally scaffolds durable recovery contracts and skeletons. Follow-up plan should handle deeper migration:

1. Real supervisor local IPC transport (Unix socket/named pipe).
2. Supervisor owns PTY spawn/write/resize/kill/read.
3. Stream replay from scrollback journal.
4. Close modal fully wired to Tauri close events.
5. ACP process ownership/recovery.
6. SSH/browser/editor recovery metadata integration.
7. Full crash smoke tests.

These are large enough to deserve separate plans/PRs.
