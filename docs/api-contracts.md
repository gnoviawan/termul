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

## Notes

- This is an **internal desktop IPC API**, not a third-party/public integration API.
- The most important compatibility point is keeping Rust command payloads and shared TS types aligned.
- Browser annotation features add an additional script-driven contract between injected page JS and native commands.

---

_Generated using BMAD Method `document-project` workflow_
