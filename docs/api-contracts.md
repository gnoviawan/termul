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

## Filesystem Scope Commands

### `fs_scope_grant`

**Purpose:** Re-grant runtime filesystem scope for restored project roots and
worktree paths. The dialog plugin extends the fs scope when a folder is picked,
but that grant is in-memory and lost on restart, while the static `fs:scope`
capability only allowlists specific drives — restored projects elsewhere fail
with `forbidden path` after restart. The renderer (`useProjectsLoader`) calls
this before hydrating the file explorer.

**Input:**
- `paths`: directory paths to allow recursively (project roots + worktrees)

**Returns:** `{ granted: string[], failed: { path, error }[] }` — per-path
failures (e.g. a detached external drive) do not fail the whole call.

Web/remote mode is a no-op (`grantFsScope` returns success without invoking);
browser fs access is enforced by the server's own permission model.

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

Supported request types are `spawn`, `write`, `resize`, `kill`, `attach`, `get_cwd`, `get_git_branch`, `get_git_status`, `get_exit_code`, `detach`, `rotate_claim`, `revoke_claim` and `list_preserved`. Replies use the existing `IpcResult` shape with the request `id`. Output frames are `{ "type": "data", "terminalId": "...", "data": [byte...] }`; event frames contain the transport-neutral exit/cwd/git/exit-code payload. `attach` sends bounded retained scrollback before subscribed live output.

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

- `authMethods: { id: string; name: string; description?: string; type: 'agent' | 'terminal' | 'env_var'; args?: string[]; env?: Record<string, string> }[]`

Methods are propagated verbatim — there is no agent-type filtering. An agent that
advertises no methods sends `authMethods: []` (a no-auth agent). `type` defaults to
`'agent'` on older payloads; `args`/`env` are present only for `terminal` methods
(the agent binary is invoked with `args` appended and `env` merged). `env_var`
methods carry `type` only — the renderer shows them disabled ("not supported") and
never sends them to `authenticate`. `logout` remains out of scope (Ask First).

**2. Authenticate before `session/new`.** The store retains the advertised methods
and, before creating a session (`create_session`), runs `authenticate_agent`
(`authenticate(methodId)`) when the agent advertises auth:

- exactly one method **of type `agent`** → authenticate that method, then create
  the session;
- a single `terminal` or `env_var` method → **no auto-auth** (terminal methods
  require an explicit click that spawns a login terminal; `env_var` is never
  sent) — `session/new` runs directly;
- more than one method → **do not choose one**; surface an actionable
  "multiple sign-in methods" failure that lists the method names (there is no
  automatic "unambiguous default" pick), **except Factory Droid** when the user
  has explicitly saved a host-wide Factory key: select its `factory-api-key`
  method on later connections;
- no method (or only empty/whitespace ids) → unchanged spawn → `session/new` flow.

For the default `agent` auth type the provider owns the login UX (it may open its
own browser); Termul never invents a client-side login-URL redirect. Apart
from the opt-in Factory key described below, it does not store provider
credentials. The `authenticate` invoke uses `{ agentId, methodId }`.

**2c. Factory Droid key.** The Factory API Key button in Agent Chat opens a
password input rather than calling ACP `authenticate` without a key. The renderer
sends the candidate to the host via `acp_factory_key_save` (Tauri) or authenticated
`POST /acp/factory-key` (browser), never to project persistence or browser storage.
The host starts a temporary Factory Droid ACP process with `FACTORY_API_KEY`,
authenticates, creates an ephemeral session, then writes the key to the OS
keychain if those checks pass. Since an agent may defer credential verification
until the first model request, these checks alone do not prove the key works
end-to-end. `acp_factory_key_status` / authenticated `GET /acp/factory-key`
return only whether a key is stored. Subsequent Factory Droid spawns overlay the
stored key, leaving active processes and sessions untouched. A missing or
unusable OS secret store rejects saving, but browser Login and explicitly
configured environment keys still work. The web endpoints require an enabled
Termul web-auth gate; the browser only submits a key over HTTPS or loopback.
Factory Login remains an explicit choice even with a stored key.
The key form is offered when Factory requests authentication, not in the
agent picker after an existing browser login. Saving checks through a
temporary process and prepares a new process for future chats; existing live
chats and their agent identity remain intact.
The bundled Factory launcher uses `droid exec --output-format acp`. The host
also upgrades the old `acp-daemon` argument when spawning a registry-backed
Factory config, including saved configs and remote catalog entries: the old
mode initializes but its Droid child exits with code 1 at `session/new` when
Termul attaches its plan MCP server.
Factory Droid may acknowledge `session/set_config_option` with `{}` rather than
the ACP-required `configOptions` snapshot. Only for this agent, the host
interprets that response as success without a snapshot; desktop and web
clients retain their known options and update the chosen value locally.
Creating another Factory session in the same Droid process resets the model
of its existing sessions. Termul therefore does not refill a Factory warm
session after launch; a later chat uses a new Droid process while keeping
earlier sessions alive. Login remains available in the auth-required banner,
not as a permanent composer button once a session is ready.
With no stored Factory key, a new Droid process tries `session/new` using the
CLI's existing browser-login state before offering the auth-required banner.

**2a. Terminal auth methods (headless login).** Clicking a `terminal` method in the
auth banner spawns an ordinary termul terminal tab (`kind:'shell'`, titled
`Sign in — <agent>`) running the agent binary with the method's `args`/`env` in the
session cwd. Exit code 0 → `authenticate(methodId)` runs and session creation
proceeds; non-zero → toast and the banner stays. No live PTY is killed or
recreated — the login terminal is an extra tab.

**2b. Browser auth handoff (headless servers).** On POSIX the host injects a
browser-open shim into the agent's PATH (`xdg-open` et al. append the URL to a
sink file; `BROWSER` points at the shim). A driver-side watcher fans out
`acp:browser_open_request` `{agentId, url}` (on web an `agents` watch delta, see State watches); the renderer records it in
`pendingBrowserOpen[agentId]` (cleared on auth success, kill, or disconnect) and
shows a dialog with the URL plus Open (system browser via `openerApi` on desktop,
`window.open` on web), Copy, and a paste-back input. The user completes sign-in on
their own browser, copies the failed `127.0.0.1` redirect, and pastes it back:

For Factory Droid the captured Login URL opens automatically, with a waiting
status and the same Open/Copy controls if browser popups are blocked. Its
device-pairing flow completes when Droid confirms sign-in; paste-back remains
available if the provider uses a localhost callback instead.

- WS request `acp_deliver_auth_redirect {agentId, url}` → the host validates **http(s) scheme AND loopback
  host** (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) — non-loopback is
  rejected before any fetch (SSRF guard) — then GETs the URL with redirects
  disabled and returns the HTTP status. The agent's own callback listener binds
  the port embedded in the pasted URL, so replay needs no port knowledge.
- On desktop the same dialog appears but "Open" completes the localhost callback
  natively — no paste-back needed. Windows has no shim (native open works).

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

#### Persisted plan snapshot (`termul-plan` fence)

When a turn ends (`_onPromptComplete` in `src/renderer/stores/acp-store.ts`), the renderer
snapshots the live `plans[sessionId]` onto the just-finished assistant message's `blocks` as
a fenced code block with language `termul-plan`:

````md
```termul-plan
[{"content":"Read AC file","status":"completed","priority":"high"},{"content":"Fix bug","status":"in_progress","priority":"high"}]
```
````

The fence JSON is `JSON.stringify(PlanEntry[])` — shape 1:1 with `PlanEntry`
(`src/renderer/lib/acp-api.ts`). One fence per assistant message (last write wins; a prior
fence on the same message is replaced). The snapshot rides on the existing `ChatMessage.blocks`
persistence path (no new schema field).

On `openHistorySession`, the renderer scans assistant messages in reverse for the
fence, parses the JSON, and repopulates `plans[sessionId]` before any new `acp:plan_update`
would arrive — so a reopened chat shows the prior plan immediately. Malformed JSON is dropped
from the plan store (logged `source: 'planRehydrate'`); the agent can still emit a fresh plan.

> **Cache-only rehydration:** The fence lives in the renderer's in-memory `messages` projection
> and the `payloadCache` (updated on `_onPromptComplete`). The durable store (CAP-2 host-owned
> history) does not contain the fence — cross-restart rehydrate does not work. In-session
> rehydrate (switching away and back) works via the cache update. Fixing cross-restart requires
> a host-side synthetic record (tracked in `_bmad-output/deferred-work.md`).

> **Renderer memory bounds (CAP-1/CAP-2):** The live transcript window is bounded on the
> renderer side, losslessly:
>
> - **Payload cache pins** — at most 8 pinned entries (`markSessionPayloadPinned`); the oldest
>   pin is evicted when the cap is exceeded, and `selectProject`/`addProject`/`deleteProject`
>   unpin the switched-away project's sessions (`unpinProjectSessionPayloads`). Evicted cache
>   entries refetch from the host on scroll-up — nothing is lost.
> - **Live message window** — `trimLiveWindow` caps `messages[sessionId]` at 300 (+ the
>   reader's backfill allowance; the in-flight streaming tail is never trimmed). Trimming
>   engages only after a durability probe (`loadSessionPayload`) confirms the host holds the
>   full payload; a session whose probe resolves `null` (`live_only` / degraded host) is
>   untrimmable and keeps every message.
> - **Live tool calls** — `toolCalls[sessionId]` plateaus at 500 (`MAX_LIVE_TOOL_CALLS`):
>   the oldest *finished* calls drop, in-flight ones are always retained, and every install
>   path (reopen/resume/recovery) applies the same cap.
> - **Tool raw output clamp** — a string `rawOutput` ≥ 32 KiB clamps to 32 KiB +
>   a `[termul: tool output truncated]` marker on live update (logged once per toolCallId
>   without content; non-string values pass through).

The `termul-plan` fence is rendered inline inside historical (non-streaming) messages by
`TermulPlanRenderer` (`src/renderer/components/chat/ChatMarkdownPlanFence.tsx`) as a read-only
`PlanPanel`. The live streaming turn shows the sticky `PlanPanel` pinned in `AgentChatPanel`
instead — the inline renderer is gated to `!streaming` so an in-flight turn never renders a
duplicate plan UI.

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

### `send_prompt` errors

When a *different* prompt is rejected because a turn is already in flight, Rust returns a string containing the stable code `ACP_TURN_IN_PROGRESS` (matched by renderer `ACP_TURN_IN_PROGRESS_CODE` in `prompt-queue-orchestration.ts`; on `/ws` the same case is `err.code: "rate_limited"`). Do not reword this prefix without updating both sides.

### `send_prompt` reply and `turnId` dedupe

Every carrier (the WebSocket and the desktop's Tauri channel) runs the same shared service (`src-tauri/src/web/prompt_turn.rs`). The reply is either the ACP stop reason string (the turn ran on this call) or a receipt object for a resend of a `turnId` the host already saw:

- `{"receipt":"in_progress"}` — the same `turnId` is still running;
- `{"receipt":"accepted"}` — the same `turnId` already finished (including by error, timeout or crash).

A same-`turnId` resend is never `rate_limited`/`stale`. A different `turnId` while a turn runs stays `ACP_TURN_IN_PROGRESS` / `rate_limited`. Callers that omit `turnId` get no dedupe.

### Turn terminators

Every accepted turn ends with exactly one durable, session-scoped `acp:prompt_complete {sessionId, turnId?, stopReason}`. `stopReason` is an ACP stop reason (`end_turn`, `cancelled`, …) or a host terminator: `error` (agent RPC failure, or the turn could not start after acceptance), `timeout` (idle/hard turn deadline), `crashed` (the agent connection closed with the turn active). The existing `acp:agent_error` is still emitted for `error`/`timeout`. A second terminator for the same `turnId` is dropped, and any terminator releases the turn claim. Host shutdown keeps its separate `interrupted` marker.

### Agent and session endings

Every ending of an agent is announced to every connected client, never only to the one that asked for it. A kill (`kill_agent`), an idle reap and a crash emit `acp:session_closed {agentId, sessionId, reason}` for each live session, then `acp:agent_disconnected {agentId, reason}` (a crash emits `acp:agent_crashed` and `acp:agent_error` first). `close_session` emits `acp:session_closed` with `reason: "closed"` and leaves the agent running. `reason` is one of `killed`, `reaped`, `crashed` or `closed`. Only process shutdown (`kill_all`) is silent.

`close_session` during a running turn cancels the turn, waits for its terminator, then closes the session, so the turn still ends with exactly one `acp:prompt_complete` followed by `acp:session_closed`. If the agent does not confirm the cancel in time, the host drops the session locally, emits `acp:session_closed`, and replies with an error.

The host reaps an agent only after `--agent-idle-window-secs` (default 1800) with no host-observed activity: no running turn, no unanswered approval, question or elicitation, no running agent-owned terminal and no reopen in flight. Connections, subscriptions and presence never keep an agent alive, and a disconnect never stops one.

### `send_prompt` durability ordering

The `send_prompt` handler persists the prompt so a transport failure can never erase an accepted user message. The handler:

1. verifies authoritative session ownership (`AcpManager::owns_session`) — rejects a cross-agent session id before any durable write;
2. claims the turn by `turnId` (above);
3. resolves the ephemeral flag (`AcpManager::is_ephemeral_session`) — backend-ephemeral utility sessions never get a `user_prompt` record (no durable history or sidebar row);
4. starts the prompt on the driver with a one-shot accept hook: the driver thread runs it the moment it ACCEPTS the prompt, before the turn task exists, and the hook sequences + fans out the durable `user_prompt` (`WsRelaySink::record_user_prompt`; payload `{agentId, sessionId, turnId, content}`) — so it can never be delivered after a chunk of its own turn, and a prompt the driver rejects (`ACP_TURN_IN_PROGRESS`) leaves no `user_prompt`;
5. awaits the durable flush (`WsRelaySink::flush_prompt_record`) after acceptance; a flush failure is logged with session context only (never prompt content) and does not unwind the accepted turn.

A reopened chat materializes the user bubble (from the durable `user_prompt` record) and derives the title, even for agents (e.g. OpenCode) that do not reliably send a live `session_info_update` title.

### One seq authority per session log

`WsRelaySink` (`src-tauri/src/web/sink/`) numbers every record of a session log. Relay events and host-authored records (`local_title_generated` for a background title, `agent_switch`) take seqs from the same counter; the session writer never assigns one. Assign + durable enqueue + ring append + per-client enqueue run in one critical section, so a subscription never has a gap between its replay and its live events and receives each event it is given in seq order, once. Replay skips seqs that are absent from disk (events that are not durable); the cursor work that follows adds drop handling for slow peers. The critical section only queues the durable write: the disk write is asynchronous and never ordered before delivery. A replay or snapshot that reads from disk first waits for the writer queue (the writer barrier) and registers under the same lock; subscriptions without persistence read the in-memory log only. The shutdown `interrupted` marker takes its seq from the relay through `SeqAuthority`. A host record is durable and live under one seq (`record_host_event`); `local_title_generated` is relay-only (desktop keeps getting the `session_info_update` twin).

### Log epochs and the replay cursor

A replay cursor is `(logEpoch, lastSeq)`: `lastSeq` only means something against the log incarnation `logEpoch` names. A durable session's epoch is minted at creation and stored in its `metadata.json` (`logEpoch`; a legacy file gets one when the store is loaded, written back at that load), so it survives a host restart. It rotates on a restart when the session's seq frontier had run ahead of the disk: a live-only event (e.g. `permission_request`) takes a seq the JSONL never holds, the first one marks the metadata (`headAheadOfDurable`, host-internal), and a load that finds the mark mints a new epoch and clears it. A non-durable session's epoch is minted per process; a terminal's per spawn. `WS_PROTOCOL_VERSION` is 7 (3 introduced the epoch fields, 4 the `gap` and `heartbeat` frames, 5 the `watch` and `unwatch` requests and the `watch` frame, 6 the removal of the `projects_changed`, `chat_history_changed` and sid-less agent events, 7 the `fs`, `store` and `terminals` watches and the removal of `watch_project`, `unwatch_project`, `fs_changed`, `fs_watch_ended`, `worktree_branch_renamed` and the sid-less `browser_open_request`).

- `subscribe{sessionId, lastSeq?, logEpoch?}` replies `{sessionId, replayed, logEpoch, headSeq}`; `headSeq` is the allocated seq frontier read under the seq lock at registration. Events with `seq <= headSeq` are replay (the durable log may skip non-durable seqs); events above it are live. A different `logEpoch`, or `lastSeq > headSeq`, replies `stale` and registers nothing: the client installs `recover_session_snapshot` instead (server history mode) and continues from its `(logEpoch, watermark)`. In live-only mode there is no snapshot: the client drops the cursor and subscribes live, and reports the session as degraded. A client also never sends a nonzero cursor without its epoch: it takes the same snapshot path.
- `recover_session_snapshot` replies `{sessionId, watermark, headSeq, logEpoch, events}`; `get_session_cursor` replies `{sessionId, watermark, logEpoch?, headSeq?}` (the epoch fields are absent for a session the host does not know). `get_session_payload` carries `metadata.logEpoch` (omitted when the session has none).
- Terminal `attach{terminalId, claim, lastSeq, logEpoch?}`: a cursor from another spawn's epoch, or ahead of the log head, replays the whole retained log with `reset: true` (the `replay` frame and the attach reply both carry `reset` and `logEpoch`); the client clears the terminal first. Clients send the epoch they learned with the cursor; a nonzero cursor with no known epoch goes out as `logEpoch: ""`, which matches no epoch, so it replays everything with `reset`. The host applies the same rule itself: a nonzero cursor with no `logEpoch` is refused too. The desktop `terminal_attach` command takes the same optional `logEpoch`.

### Bounded delivery, gap frames and heartbeat

Every session subscription holds a bounded channel (256 items, plus room for the replay it started with) into its connection's outbound queue; the host never grows a queue for a slow peer. Fan-out does not wait:

- A LOSSY event (`message_chunk`, `tool_call_update`, `commands_update`, `plan_update`) that finds the channel full is dropped. The host then sends one top-level `{"type":"gap","sid":"..."}` frame (no `seq`) as soon as the channel has drained, even if no further event follows. The client answers with `recover_session_snapshot`.
- A reliable or idempotent event that finds the channel full is never dropped: the host closes the connection and the client resumes by `(logEpoch, lastSeq)`. The connection queue's own overflow tolerance (`ServerConfig::overflow_tolerance`, default 15) applies behind the channel.
- The write loop sends `{"type":"heartbeat"}` every 10 s straight to the socket (no `seq`, never queued behind events). The client treats any host frame as proof of life; 2.5 heartbeat intervals without one start a probe, then a reconnect. The client's own `ping` request now only keeps the host's watchdog fed.
- The client applies events with `seq <= headSeq` (replay, holes allowed) in order, and events above `headSeq` only when they are `last + 1`. Any other seq is not applied: the session installs a snapshot (one in flight per session) and resumes at its watermark. Events that overtake a `subscribe` or snapshot reply are held until the reply names the replay boundary; a `gap` held during a sync is always acted on, because the drop may lie past the snapshot's head. A session whose resubscribe keeps failing degrades alone (cursor retries, then snapshot, then `degradedRecoverySessions`); the reconnect never fails as a whole.

### State watches

The project list, the chat-history index, the agent roster, a project's file changes, shared store keys and a project's terminal set are state, not session logs. They reach a client through `watch` instead of `seq = 0` broadcasts, which a client could miss, receive twice or never receive on a socket without a session subscription.

- `watch{watch, scope?}` with `watch` one of `projects`, `chat_history`, `agents` (scope is always `""`), `fs` and `terminals` (scope = a project id) or `store` (scope = a store key: `shared/...`, or `device/<deviceId>/...` of the connection's own device; any other key is refused with `STORE_KEY_SCOPE`). The host queues one top-level frame `{"type":"watch","watch","scope","revision":{"hostEpoch","n":1},"reset":true,"state":...}` and then replies `{watch, scope, revision}`, so the client holds the state when the reply arrives. `unwatch{watch, scope?}` is idempotent. View-only connections may watch. An unknown watch or scope is `unsupported`; an `fs` watch of an unknown or archived project is `not_found`; a `store` watch on a host without a store is `STORE_UNAVAILABLE`; a full connection queue is `rate_limited`. `watch_project` and `unwatch_project` no longer exist.
- Each change is a delta frame `{"type":"watch","watch","scope","revision":{"hostEpoch","n"},"delta":...}`. `n` counts per connection and watch, and a socket receives each watch once, whatever sessions it subscribed to. A second `watch` of the same watch replaces the subscription and restarts at `n = 1` with fresh state.
- State and deltas: `projects` — state `{projects, defaultProjectId}` (what `GET /projects` returns), delta the replacement state; `chat_history` — state the persisted-session index (what `list_persisted_sessions` returns, empty without durable history), delta `{changed: [sessionId]}` (empty list: changed in bulk) which the client answers by refetching; `agents` — state the live agent summaries, delta `{event, payload}` for `agent_spawned`, `agent_crashed`, `agent_error` and `agent_disconnected` (a kill or an idle reap arrives as `agent_disconnected` with a `reason`; applying one is idempotent). `agents` also carries the transient `{event: "browser_open_request", payload: {agentId, url}}`, which is not roster state, so a delta lost to a gap is lost. `chat_history` also carries `{changed: [], event: "worktree_branch_renamed", payload: {worktreePath, oldBranch, newBranch}}` for a branch rename. `fs` — state `{root}` (a state after the first one tells the client to refresh its trees), delta `{root, paths}` for one debounced batch of changes, and a last delta `{ended: true, reason}` when the project is no longer watchable (the host then releases the subscription; the client asks again). `store` — state and delta `{exists, value?}`, the value the key holds after a write or delete from any connection. `terminals` — state and delta `{terminals: [{terminalId, projectId, cwd, attached}]}`, the project's terminals including detached ones, replaced after each spawn, kill, reap, first attach or last detach, with no claim credential (`list_preserved` still issues claims).
- The host never waits to queue a delta. A delta that finds the connection queue full is dropped but keeps its `n`, so the next frame shows the hole. A `{"resync":true}` marker then takes the next `n` and is queued as soon as there is room, so a hole shows even when no later change comes.
- The client applies a delta only when it is `n + 1` of the same `hostEpoch`. A skipped `n`, a different epoch (a new serve start), a `resync` marker or a reconnect makes it send `watch` again and rebuild from the fresh state.
- `projects_changed` and `chat_history_changed` no longer exist, and the relay no longer sends `agent_spawned`, `agent_crashed`, `agent_error` or `agent_disconnected` without a session as `seq = 0` events. `browser_open_request`, `worktree_branch_renamed`, `fs_changed` and `fs_watch_ended` no longer exist either: the relay sends no `seq = 0` event except the `auth_required` handshake frame, and an agent-level event no watch carries is logged and dropped. The web client reads the watches: the project switcher rebuilds its list from `projects`, the chat-history sidebar installs the `chat_history` index and refetches on a delta, the agent store reconciles its roster from `agents` and takes `browser_open_request` from it, the explorer refreshes from `fs`, and `watchStoreKey` exposes the `store` watch. The persistence facade (`watchShared`) watches each shared key (`shared/lww/...`, `shared/cas/...`) once the page has read it, applies a frame only when it differs from the value the page last read, wrote or applied (so the echo of its own write is dropped), and applies nothing while the key's last read failed; owners only update memory, so an applied value is never written back.

### Per-project workspace record

A project's open files and pane layout live only in the device's own store key `device/<deviceId>/workspace/<projectId>` (`PersistenceKeys.workspace(projectId)`; value `{"_version":1,"data":<PersistedEditorState>}`); the host keeps no second copy. The desktop's own plugin store uses the same logical key `workspace/<projectId>` and renames its old `editor-state/<projectId>` keys once, when the file is first loaded. When the first device adopts a pre-existing store, the host converts each retired workspace manifest found under `<state or app data dir>/workspace-manifests/<projectId>.json` into that record (only where the device has none) in the same write as the adoption, then renames the folder to `workspace-manifests.imported-<unix time>`. Corrupt, newer-schema or unreadable manifests are skipped with a warning and stay in the folder. A parked pre-v2 `editor-state/<projectId>` key is adopted as `workspace/<projectId>`; a store that adopted under an earlier release keeps its `device/<deviceId>/editor-state/*` keys.

### Project registry commands

One durable `ProjectRegistry` per host owns the project list: `termul-server` keeps it in its projects file, the desktop in `<app data dir>/projects.json` (locked beside `store.json`, opened once at setup, **not** cleared by `remote_server_stop`). Every command below runs through one host command service: it validates, writes the candidate to disk (temp file, fsync, rename) and only then swaps memory, so a failed write replies an error and changes nothing; then it publishes the new state to every `projects` watcher.

| `/ws` request | HTTP | Request fields | Reply |
| --- | --- | --- | --- |
| `add_project` | `POST /projects` | `id` (client-minted), `name`, `path`, `color`, `isArchived?` | `{project}`. Repeating the same `id` and folder is ok; the same `id` with another folder is `duplicate` (`DUPLICATE`); a reserved id or an unusable folder is `unsupported` (`VALIDATION_ERROR`) |
| `update_project` | `PUT /projects/{id}` | `projectId`, `name?`, `color?`, `isArchived?`, `path?`, `cascade?` | `{}`; `not_found` for an unknown id. A `path` moves the project's root: it is checked and canonicalized like `add_project`'s (a reserved id or an unusable folder is `unsupported` / `VALIDATION_ERROR`), the folder the project already has is not a move, and the move is persisted with the other fields |
| `remove_project` | `DELETE /projects/{id}?cascade=` | `projectId`, `cascade?` | `{}`; an absent id is ok |
| `set_default_project` | `POST /projects/default` | `projectId` | `{}`; `not_found` unless the project is registered, not archived and has a folder |

- Add, update and remove are idempotent by `projectId`, so they carry no ledger `commandId`. Archiving or removing the default project clears the default; the default only changes through `set_default_project`.
- `project_busy` (HTTP `IpcBody.code` `PROJECT_BUSY`): removing or archiving a project, or moving its root with `update_project` `path` (the working directories of what is bound to it would leave the root), that still has live sessions (host-stamped `projectId`) or terminals is refused and nothing changes. `err.details` (HTTP `details`) is `{"sessions":[sessionId…],"terminals":[terminalId…]}`. With `cascade: true` (HTTP: `?cascade=true` on DELETE, `"cascade":true` in the PUT body) the host cancels and closes the bound sessions (an agent is stopped only when no other session uses it), force-kills the bound terminals, drops the project's fs watches, then removes or archives the project; session/terminal events fan out through their usual paths. If something cannot be stopped the project stays and `project_busy` lists the leftovers. While a remove or archive runs, `create_session` and terminal `spawn` for that project are refused `project_busy`.
- `WsError` gains the optional `details` field (additive; today only `project_busy` sets it) and `IpcBody` the same `details`.
- Registry file: schema 4 (`imported: bool` added to v3). A v1-v3 file loads and is copied to `<name>.pre-v4-<ts>.bak` before its first rewrite; a newer schema is refused and never overwritten; a corrupt file is copied to `<name>.corrupt-<ts>.bak`. The synthetic seed project (only from the removed `--project-root` / `$TERMUL_PROJECT_ROOT`) lives in memory only; the desktop never seeds one.
- Tauri: `project_registry_import({projects: ProjectSummary[], defaultProjectId?}) -> {imported: boolean}` is the desktop's one-shot import of the renderer's old project list. It runs only while the file says nothing was imported, adds ids that are not registered (existing ids are kept, never overwritten), applies the default only when none is set (the synthetic seed does not count as one) and sets `imported` durably even for an empty list; a repeat replies `{imported: false}`. The renderer imports once at the first desktop start after the upgrade, then deletes its old `projects` key and keeps its per-project settings, groups and order under the device key `project-prefs`. `remote_sync_projects` (full-list push) and `set_host_default_project` no longer exist: the renderer, on the browser and the desktop alike, reads the list from the `projects` watch and changes it with the `/ws` requests above (`path` on `update_project` moves a root).

### MCP and OAuth operations name a project

The MCP server list is a file per project, `{project root}/.termul/mcp-servers.json`; there is no single host project root. Every operation names `projectId`, resolved through `ProjectRegistry::canonical_root`: an unknown, archived or pathless project (or one whose folder is gone) is refused `NOT_FOUND` and nothing is read or written.

| Operation | HTTP | Request | Reply |
| --- | --- | --- | --- |
| Read the list | `GET /mcp-servers?projectId=` | n/a | `[McpServer…]` (empty when the file is absent) |
| Write the list | `PUT /mcp-servers?projectId=` | JSON array | `{}`; a write guard (`FORBIDDEN`) applies before the project is resolved |
| Start OAuth | `POST /mcp-servers/oauth/start` | `{projectId, serverUrl}` | `{authUrl, redirectUri}`; the URL must be an enabled http/sse entry of THAT project's list, else `UNAUTHORIZED_SERVER_URL` |
| OAuth status | `POST /mcp-servers/oauth/status` | `{projectId, serverUrl}` | `{hasToken}` |
| OAuth disconnect | `POST /mcp-servers/oauth/disconnect` | `{projectId, serverUrl}` | `{}` |

- OAuth tokens stay keyed by server URL and are host-global (`acp/mcp_oauth.rs`): a token is the host's credential for that URL, not a project's. `status` and `disconnect` validate the project but read and delete the one URL-keyed token.
- Tauri: `remote_sync_mcp_registry({projectId, registry})` writes that project's file (same refusal as above, no default-project or home-directory fallback). The desktop OAuth/probe commands (`acp_mcp_oauth_*`, `acp_probe_mcp_server`) authorize and write nothing, so they take the server URL / config only. `POST /mcp-servers/probe` is unchanged.
- `--project-root` (and `$TERMUL_PROJECT_ROOT`) are removed options: still parsed for one minor release with a startup warning, they only seed one in-memory project while the registry has no usable project. No flag, no seed; the onboard wizard no longer asks for a root.

### Host offline

A host that stops on purpose closes every socket (`/ws`, `/terminal/ws` and the persistence socket) with `Close(1001)`. The web client reads the close code. Code `1001` puts the connection in the `host-offline` state instead of the backoff reconnect loop: no reconnect timer runs, and the status bar, the terminal overlay and the chat panel show "Host offline" with a Retry action. The client asks `GET /health` every 15 s (5 s budget per request). It also asks at once on a user retry, a wake or a network-online signal. When the host answers, the client reconnects, resubscribes by cursor and rebuilds its watches from fresh state. Every other close code keeps the existing backoff reconnect.

## Notes

- This is an **internal desktop IPC API**, not a third-party/public integration API.
- The most important compatibility point is keeping Rust command payloads and shared TS types aligned.
- Browser annotation features add an additional script-driven contract between injected page JS and native commands.

---

_Generated using BMAD Method `document-project` workflow_
