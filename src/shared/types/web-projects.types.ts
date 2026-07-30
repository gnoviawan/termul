/**
 * Web/remote project list wire contract (runtime-neutral).
 *
 * The desktop-hosted shared-live web server (`remote_server_start`) mirrors the
 * desktop's non-archived project list into an in-memory `ProjectRegistry` (a
 * deliberate bridge to Epic 4). The browser reads it via `GET /projects` and
 * receives live `projects_changed` WS events when the desktop mutates its store.
 *
 * # Secret boundary (frozen constraint)
 *
 * `ProjectSummary` carries NO env-var values (secret or plain) — redact-by-
 * omission. Secrets already live in secure storage; plain env is omitted from
 * the mirror for the interim. Only the identity/display fields a project
 * switcher needs cross the wire.
 *
 * Runtime-neutral: no `@tauri-apps/*` imports, no `@renderer/*` imports.
 * ESM-first. Strict-typed (no `any`). Mirrors the Rust structs in
 * `src-tauri/src/web/project_registry.rs` + `projects_api.rs` one-to-one.
 */

/** A single project's summary as exposed to the web/remote client. */
export interface ProjectSummary {
  /** Stable project id (matches the desktop `Project.id`). */
  id: string
  /** Display name. */
  name: string
  /** Color token (one of the desktop `ProjectColor` literals, as a string). */
  color: string
  /** Working-directory path, or `null` when the project has no cwd (cannot switch). */
  path: string | null
  /** `true` when the project is archived (rendered greyed, not clickable). */
  isArchived: boolean
  /** `true` when this is the desktop's active project. */
  isActive: boolean
}

/** `GET /projects` response body (wrapped in `IpcResult<T>` by the server). */
export interface ProjectListPayload {
  /** Non-archived + archived summaries (the web list shows both, archived greyed). */
  projects: ProjectSummary[]
  /** The desktop's active project id, or `null` when none. */
  activeProjectId: string | null
}

/**
 * `projects_changed` WS event payload (agent-level: `sid: null`, `seq: 0`).
 *
 * Carries only the new `activeProjectId` — the web client refetches `GET
 * /projects` for the full list rather than receiving the payload inline (the
 * list can be large and the desktop is the source of truth).
 */
export interface ProjectsChangedEvent {
  /** The desktop's new active project id, or `null` when none. */
  activeProjectId: string | null
}

/** `switch_project` WS request payload (client→server). */
export interface SwitchProjectRequest {
  /** Target project id (resolved to a cwd via the registry server-side). */
  projectId: string
}

/** Completed `switch_project` outcome (server→client). */
export interface SwitchProjectCompleted {
  status: 'completed'
  projectId: string
  sessionId: string
  cwd: string
  mcpServerCount: number
}

/** Deferred `switch_project` outcome while the current turn finishes. */
export interface SwitchProjectQueued {
  status: 'queued'
  projectId: string
  currentSessionId: string
}

/**
 * Cold-tab `switch_project` outcome (server→client). The shared active project
 * changed but no session was created and no agent was spawned — the web
 * client spawns the agent lazily when a chat starts (Ask-First resolution
 * stands). `cwd` lets the client resolve the project root without a second
 * registry round-trip. Mirrors the Rust `SwitchProjectOutcome::Selected`.
 */
export interface SwitchProjectSelected {
  status: 'selected'
  projectId: string
  cwd: string
}

/** Discriminated `switch_project` reply payload. */
export type SwitchProjectReply =
  | SwitchProjectCompleted
  | SwitchProjectQueued
  | SwitchProjectSelected

/** Reliable completion event for a previously queued switch. */
export interface ProjectSwitchCompletedEvent extends SwitchProjectCompleted {
  requestId: string
  previousSessionId: string
}

/** Reliable, correlated failure event for a previously queued switch. */
export interface ProjectSwitchFailedEvent {
  requestId: string
  projectId: string
  previousSessionId: string
  message: string
}
