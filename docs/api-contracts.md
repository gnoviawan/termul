# Termul Manager - API Contracts

**Date:** 2026-05-09
**Surface:** Internal Tauri command and event API

## Overview

Termul Manager does not expose a public HTTP API. Its primary integration surface is an **internal IPC contract** between the React renderer and the Rust/Tauri runtime.

This contract is implemented through:

- Tauri `invoke` commands defined in `src-tauri/src/commands.rs`
- Event listeners emitted from the runtime and consumed in renderer adapters
- Shared TypeScript contracts in `src/shared/types/ipc.types.ts`

## Response Pattern

Most native commands use a common result shape:

```ts
{ success: true, data: T }
```

or

```ts
{ success: false, error: string, code: string }
```

The Rust side implements this via `IpcResult<T>` and the renderer mirrors it in shared types.

## Synchronous Commands

### `detect_shells`

**Purpose:** Detect available shells and the default shell.

**Returns:**
- `available`: array of shell descriptors
- `default`: default shell descriptor if found

### `get_default_shell`

**Purpose:** Return the default shell only.

### `get_home_directory`

**Purpose:** Return the current user's home directory with platform-aware fallback.

## Terminal Commands

### `terminal_spawn`

**Purpose:** Spawn a new PTY-backed terminal.

**Input:**
- optional shell path/name
- optional cwd
- optional env map
- optional cols/rows

**Returns:**
- terminal runtime id
- resolved shell
- cwd
- pid
- cols/rows

### `terminal_write`
Writes data to an existing PTY.

### `terminal_resize`
Resizes an existing PTY.

### `terminal_kill`
Terminates an existing PTY.

### `terminal_get_cwd`
Returns tracked current working directory for a terminal.

### `terminal_get_git_branch`
Returns tracked git branch for a terminal.

### `terminal_get_git_status`
Returns tracked git status summary for a terminal.

### `terminal_get_exit_code`
Returns last known exit code for a terminal.

### `terminal_update_orphan_detection`
Updates orphan terminal lifecycle policies.

### `terminal_add_renderer_ref`
Registers a renderer/view attachment against a terminal.

### `terminal_remove_renderer_ref`
Removes a renderer/view attachment.

### `terminal_set_visibility`
Updates visibility state to influence tracker polling behavior.

## Browser Tab Commands

### `browser_tab_create`
Creates a child browser webview with bounds and initial URL.

### `browser_tab_navigate`
Navigates an existing browser tab to a URL.

### `browser_tab_resize`
Updates browser child webview bounds.

### `browser_tab_show`
Shows a hidden browser child webview.

### `browser_tab_hide`
Hides a browser child webview.

### `browser_tab_destroy`
Destroys a browser child webview.

### `browser_tab_go_back`
Navigates backward in history.

### `browser_tab_go_forward`
Navigates forward in history.

### `browser_tab_reload`
Reloads the current page.

### `browser_tab_inject_annotation`
Injects the annotation overlay in a target mode.

### `browser_tab_remove_annotation_overlay`
Removes the annotation overlay.

### `browser_tab_inject_annotation_markers`
Pushes marker annotations into the browser overlay.

### `browser_tab_update_annotation_marker_selection`
Updates which annotation marker is selected.

### Browser Reporting Commands
Used by injected page scripts to report browser state back to the app:

- `browser_tab_report_url`
- `browser_tab_report_loaded`
- `browser_tab_report_region_captured`
- `browser_tab_report_element_captured`
- `browser_tab_report_title`
- `browser_tab_report_annotation_marker_clicked`

## Data Migration Commands

### `data_migration_get_version`
Returns current and target schema version information.

### `data_migration_get_history`
Returns migration history records.

### `data_migration_run_migrations`
Executes pending migrations.

### `data_migration_get_schema_info`
Returns schema metadata.

### `data_migration_get_registered`
Returns registered migrations.

### `data_migration_rollback`
Runs rollback logic for a migration.

## Desktop ACP Chat History Commands

Desktop renderer chat history is stored under the Tauri app-data directory by a
Rust-owned, versioned file store. The commands preserve the existing renderer
`SessionIndexEntry` / `SessionPayload` JSON shape. `SessionPayload` carries
`{ metadata, messages, toolCalls? }`: `toolCalls` is an optional mirror of the
session's ACP tool calls so history reopens and post-reload resumes restore the
tool cards in the timeline. Persisted tool calls drop `rawOutput` and unknown
fields, normalize mid-flight statuses to `failed`, keep only the most recent
calls, and are bounded per call by a serialized byte budget
(`sanitizeToolCallsForPersistence`); payloads written before the field existed
omit it.

- `acp_history_list` returns `{ sessions, legacyImportComplete }`.
- `acp_history_get` returns one full payload or `null` when absent.
- `acp_history_save` atomically replaces one payload and its lightweight index entry.
- `acp_history_delete` removes the payload and index entry with serialized ordering.
- `acp_history_flush` is the close-path durability barrier.
- `acp_history_mark_legacy_import_complete` records verified legacy import completion.

The legacy Tauri Store is read only by the one-shot renderer migration. ACP keys
are deleted only after Rust list/get verification; unrelated preferences remain.
Desktop-hosted browser `list_persisted_sessions` and `get_session_payload` read
this durable provider directly, while the standalone server keeps its existing
persistence path and wire format.

## Web Terminal WebSocket

`GET /terminal/ws` upgrades to the browser terminal transport and is isolated from ACP `/ws`.

Client request envelope:

```json
{ "id": "terminal-1", "type": "resize", "payload": { "terminalId": "...", "cols": 100, "rows": 30 } }
```

Supported request types are `spawn`, `write`, `resize`, `kill`, `attach`, `get_cwd`, `get_git_branch`, `get_git_status`, `get_exit_code`, `add_renderer_ref`, `remove_renderer_ref`, `set_protected`, and `update_orphan_detection`. Replies use the existing `IpcResult` shape with the request `id`. Output frames are `{ "type": "data", "terminalId": "...", "data": [byte...] }`; event frames contain the transport-neutral exit/cwd/git/exit-code payload. `attach` sends bounded retained scrollback before subscribed live output.

The service deliberately does not log request data, terminal bytes, environment values, or secrets. Authentication, authorization, TLS, and sandboxing are not provided; this endpoint is unsafe for public or untrusted network exposure.

## Event Contracts

### Terminal Event Flow
The renderer expects event-style updates for:

- terminal data output
- terminal exit
- cwd changes
- git branch changes
- git status changes
- exit code changes

Shared callback types are defined in `src/shared/types/ipc.types.ts`.

### Browser Event Flow
Renderer browser adapters subscribe to:

- `browser-tab-navigated`
- `browser-tab-loaded`
- `browser-tab-region-captured`
- `browser-tab-element-captured`
- `browser-tab-title-changed`
- `browser-tab-annotation-marker-clicked`

### Updater/Menu Event Flow
The app also emits menu/updater-related events such as the updater check trigger from the native menu.

### ACP Agent Setup & Authentication Flow

ACP provider setup follows the stable ACP handshake ordering. The renderer facade
(`src/renderer/lib/acp-api.ts`) → Tauri command → ACP manager
(`src-tauri/src/acp/manager.rs`) boundary is preserved end to end.

**1. Initialize → auth-method propagation.** When an agent completes `initialize`,
the manager forwards **every** advertised authentication method to the renderer on
the `acp:agent_spawned` event as an opaque descriptor:

- `authMethods: { id: string; name: string; description?: string }[]`

Methods are propagated verbatim — there is no agent-type filtering. An agent that
advertises no methods sends `authMethods: []` (a no-auth agent). Extended auth
types (`env_var`, `terminal`) and `logout` remain out of scope (Ask First); only
the stable `id`/`name`/optional `description` surface is carried.

**2. Authenticate before `session/new`.** The store retains the advertised methods
and, before creating a session (`acp_new_session`), runs `acp_authenticate`
(`authenticate(methodId)`) when the agent advertises auth:

- exactly one method → authenticate that method, then create the session;
- more than one method → **do not choose one**; surface an actionable
  "multiple sign-in methods" failure that lists the method names (there is no
  automatic "unambiguous default" pick);
- no method (or only empty/whitespace ids) → unchanged spawn → `session/new` flow.

For the default `agent` auth type the provider owns the login UX (it may open its
own browser); Termul never invents a client-side login-URL redirect and never
stores provider credentials. The `authenticate` invoke uses `{ agentId, methodId }`.

**3. Recoverable setup failures.** Setup failures are classified deterministically
(`src/renderer/lib/agents/acp-spawn-errors.ts`) into stable categories with
distinct, actionable launcher labels — order: `multi-auth` → `spawn` → `transport`
→ `auth` → `timeout` → `unknown`:

- `transport` (destroyed stream / refused / reset connection, incl. "connection
  timed out"): the live process is **killed and evicted** from reuse before a
  retry, so exactly one fresh spawn follows;
- `auth`: the launcher shows "Authentication required" plus the diagnostic and a
  Sign-in action (only when exactly one method is advertised); a failed
  session/new that is auth-classified clears the authenticated flag so a manual
  Sign-in + retry can re-authenticate;
- `timeout`: "Session setup timed out" (the alive-but-slow agent is not killed);
- `spawn`: a missing/unresolvable binary (ENOENT), rewritten into actionable
  guidance;
- only a genuine empty-model state uses the neutral model pill / "Model
  unavailable" text — a setup failure never masquerades as a model-list problem.

## Shared TypeScript Contracts

Key shared contract areas include:

- terminal spawn and result types
- shell detection types
- persistence/session contracts
- filesystem API types
- updater state and progress types
- window close coordination types

## Error Code Conventions

Representative error codes include:

- `TERMINAL_NOT_FOUND`
- `SPAWN_FAILED`
- `WRITE_FAILED`
- `RESIZE_FAILED`
- `KILL_FAILED`
- `DIALOG_CANCELED`
- `FILE_NOT_FOUND`
- `WATCH_FAILED`
- `SESSION_NOT_FOUND`
- `SESSION_INVALID`
- `MIGRATION_*`
- `ROLLBACK_FAILED`

## ACP Agent Chat Events

ACP agent chat uses Tauri events under the `acp:` namespace (see `src-tauri/src/acp/events.rs` and `src/renderer/lib/acp-api.ts`).

### `acp:plan_update`

**Purpose:** Agent execution plan changed ([Agent Plan spec](https://agentclientprotocol.com/protocol/v1/agent-plan)).

**Payload:**

```ts
{
  agentId: string
  sessionId: string
  plan: {
    entries: Array<{
      content: string
      priority?: 'high' | 'medium' | 'low'
      status?: 'pending' | 'in_progress' | 'completed'
    }>
  }
}
```

**Semantics:**

- Emitted when the agent sends `session/update` with `sessionUpdate: "plan"`.
- Each event replaces the session plan entirely (full list).
- Empty `entries` clears the plan in the renderer (`PlanPanel` hidden).

See `docs/acp-agent-plan-compliance.md` for registry compliance tiers and agent vendor expectations.

### `acp:usage_update`

**Purpose:** Agent-reported context-window utilization for a session (ACP `sessionUpdate: "usage_update"`; requires the protocol `unstable_session_usage` feature).

**Payload:**

```ts
{
  agentId: string
  sessionId: string
  used: number
  size: number
  cost?: {
    amount: number
    currency: string
  }
}
```

**Semantics:**

- Emitted when the agent pushes a usage update; Rust forwards `used`/`size`/`cost` without additional gating (`UsageUpdateEvent` in `src-tauri/src/acp/events.rs`).
- Each event **replaces** the renderer’s current usage state for that session (`used`/`size`; optional `cost` when accepted).
- Renderer validation (`_onUsageUpdate` in `acp-store.ts`):
  - Drops the update when `used` or `size` is non-finite, or when `used <= 0` or `size <= 0`.
  - Ignores updates for unknown sessions.
  - Keeps optional `cost` only when `amount` is finite and `> 0` and `currency` is non-empty; otherwise omits cost (zero/placeholder costs are not stored).
- TypeScript mirror: `UsageUpdateEvent` / `ACP_EVENTS.usageUpdate` in `src/renderer/lib/acp-api.ts`. Keep Rust and TypeScript field names (`agentId`, `sessionId`, `used`, `size`, `cost`) aligned.

### `acp_send_prompt` errors

When a second prompt is rejected because a turn is already in flight, Rust returns a string containing the stable code `ACP_TURN_IN_PROGRESS` (matched by renderer `ACP_TURN_IN_PROGRESS_CODE` in `prompt-queue-orchestration.ts`). Do not reword this prefix without updating both sides.

### `acp_send_prompt` durability ordering

Desktop prompt persistence mirrors the WS `send_prompt` handler (`src-tauri/src/web/ws.rs`) so a transport failure can never erase an accepted user message. Before dispatching through `AcpManager::send_prompt`, the command:

1. verifies authoritative session ownership (`AcpManager::owns_session`) — rejects a cross-agent session id before any durable write;
2. resolves the ephemeral flag (`AcpManager::is_ephemeral_session`) — backend-ephemeral utility sessions are skipped (no durable history or sidebar row);
3. for non-ephemeral sessions, persists the accepted prompt through `WsRelaySink::persist_user_prompt` (the relay sequence authority + durability barrier) with the same payload shape as the web path (`{agentId, sessionId, turnId, content}`; `turnId` is `null` on the desktop path);
4. only then dispatches through `AcpManager::send_prompt`.

A persistence failure rejects dispatch (the prompt is not erased) and is logged with session context only — never prompt content. This establishes first-message title provenance on restore: a reopened chat materializes the user bubble (from the durable `user_prompt` record) and derives the title, even for agents (e.g. OpenCode) that do not reliably send a live `session_info_update` title.

## Notes

- This is an **internal desktop IPC API**, not a third-party/public integration API.
- The most important compatibility point is keeping Rust command payloads and shared TS types aligned.
- Browser annotation features add an additional script-driven contract between injected page JS and native commands.

---

_Generated using BMAD Method `document-project` workflow_
