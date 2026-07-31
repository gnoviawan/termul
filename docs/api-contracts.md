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

## ACP / AI Agent Chat Contract

ACP is an internal Agent Client Protocol integration, not a public HTTP API.
The native command inventory below is copied from `src-tauri/src/acp/commands.rs`;
the event inventory is copied from `src-tauri/src/acp/events.rs`. The renderer
mirror is `src/renderer/lib/acp-api.ts`, and `acp-transport.ts` selects Tauri
IPC on desktop or the WebSocket relay for web/remote.

### Native ACP command inventory

All commands return a Tauri `Result`; renderer facade methods reject on an ACP
error. `AgentId` and `SessionId` are string newtypes on the wire.

| Command | Inputs | Result |
| --- | --- | --- |
| `acp_spawn_agent` | `config: AgentConfig` | `AgentId` |
| `acp_kill_agent` | `agentId` | `()`; idempotent kill |
| `acp_list_agents` | none | `AgentId[]` |
| `acp_new_session` | `agentId`, `cwd`, optional `mcpServers` | `NewSessionOutcome` |
| `acp_load_session` | `agentId`, `sessionId`, `cwd` | `SessionReopenOutcome` |
| `acp_resume_session` | `agentId`, `sessionId`, `cwd` | `SessionReopenOutcome` |
| `acp_close_session` | `agentId`, `sessionId` | `()` |
| `acp_list_sessions` | `agentId`, optional `cwd`, optional `cursor` | `ListSessionsResponse` |
| `acp_send_prompt` | `agentId`, `sessionId`, optional `content` or `text` | ACP `StopReason` |
| `acp_cancel_prompt` | `agentId`, `sessionId` | `()` |
| `acp_set_config_option` | `agentId`, `sessionId`, `configId`, `valueId` | updated `SessionConfigOption[]` |
| `acp_set_mode` | `agentId`, `sessionId`, `modeId` | `()` |
| `acp_set_model` | `agentId`, `sessionId`, `modelId` | `()` |
| `acp_authenticate` | `agentId`, `methodId` | `()` |
| `acp_respond_permission` | `agentId`, `requestId`, optional `optionId` | `()`; an already-resolved request is treated as success |
| `acp_probe_runtime` | none | `AcpRuntimeProbe` |

`acp_send_prompt` requires non-empty structured content or a text fallback. A
second in-flight turn returns the stable `ACP_TURN_IN_PROGRESS` diagnostic used
by the renderer queue. Permission resolution is first-response-wins across the
desktop command and the web/remote response path.

The facade also exposes `acpInstallRegistryBinary`, `acpProbeRuntime`, and
`acpFetchRegistrySnapshot`. `acpProbeRuntime` maps to the native command above;
the registry install/snapshot helpers are renderer transport/catalog operations,
not additional commands declared in `src-tauri/src/acp/commands.rs`.

### ACP event inventory

All native event payload structs use camelCase field names. Nested content,
tool, plan, model, mode, permission, and config objects retain ACP schema
serialization.

| Event | Payload (key fields) | Meaning |
| --- | --- | --- |
| `acp:agent_spawned` | `agentId`, `capabilities`, `authMethods` | `initialize` completed; advertised auth methods are forwarded opaquely |
| `acp:session_created` | `agentId`, `sessionId`, optional `modes`, `models`, `configOptions` | A new session is ready |
| `acp:message_chunk` | `agentId`, `sessionId`, `role`, `content` | Streamed user, agent, or thought content |
| `acp:tool_call` | `agentId`, `sessionId`, `toolCall` | New tool call |
| `acp:tool_call_update` | `agentId`, `sessionId`, `update` | Tool call progress/content update |
| `acp:plan_update` | `agentId`, `sessionId`, `plan` | Full replacement of the session plan |
| `acp:commands_update` | `agentId`, `sessionId`, `availableCommands` | Available slash commands changed |
| `acp:mode_update` | `agentId`, `sessionId`, `currentModeId`, optional `availableModes` | Active mode changed |
| `acp:config_options_update` | `agentId`, `sessionId`, `configOptions` | Session configuration options changed |
| `acp:permission_request` | `agentId`, `sessionId`, `requestId`, `toolCall`, `options` | Agent requests a user decision |
| `acp:prompt_complete` | `agentId`, `sessionId`, `stopReason`, optional `turnId` | Prompt turn ended |
| `acp:agent_error` | `agentId`, optional `sessionId`, `message` | Non-fatal agent error |
| `acp:agent_crashed` | `agentId`, optional `sessionId`, `message` | Agent subprocess crash; emitted before disconnect |
| `acp:session_closed` | `agentId`, `sessionId` | Session closed explicitly or after agent loss |
| `acp:agent_disconnected` | `agentId` | Agent process disconnected/exited |
| `acp:session_info_update` | `agentId`, `sessionId`, nullable `title` | Agent session metadata changed |
| `acp:usage_update` | `agentId`, `sessionId`, `used`, `size`, optional `cost` | Reported context-window utilization and cost |

The renderer facade additionally declares `ACP_EVENTS.userPrompt` (`acp:user_prompt`)
and `UserPromptEvent` for its transport-facing contract. There is no matching
`EVENT_USER_PROMPT` declaration in `src-tauri/src/acp/events.rs`; it is therefore
not counted as a native desktop event here and must not be documented as one
without a corresponding backend source change.

### ACP setup and state semantics

- Agent setup retains every `authMethods` descriptor advertised by
  `initialize`. Zero methods preserves the normal flow; exactly one method is
authenticated before `session/new`; multiple methods require an explicit choice.
- The store is global and multi-session. Persisted history is scoped by
  `(projectId, cwd)` and loaded lazily; `activeSessionId` is only an in-process UI
  convenience.
- `ContentBlock` supports text and ACP media/resource forms. A known filesystem
  path is sent as `resource_link`; drag/drop or paste without a path uses inline
  image data or an embedded resource only when the agent advertises
  `embeddedContext`.
- Plan, tool, permission, config, mode, model, and usage updates are capability-
driven. Usage updates with invalid/non-positive values are ignored by the store;
valid updates replace the session snapshot, with positive finite costs retained.

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

## Notes

- This is an **internal desktop IPC API**, not a third-party/public integration API.
- The most important compatibility point is keeping Rust command payloads and shared TS types aligned.
- Browser annotation features add an additional script-driven contract between injected page JS and native commands.

---

_Generated using BMAD Method `document-project` workflow_
