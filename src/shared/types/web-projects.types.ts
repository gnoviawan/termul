/**
 * Web/remote project list wire contract (runtime-neutral).
 *
 * The desktop-hosted shared-live web server (`remote_server_start`) mirrors the
 * desktop's non-archived project list into an in-memory `ProjectRegistry` (a
 * deliberate bridge to Epic 4). The browser reads it via `GET /projects` and
 * receives the same list through the `projects` watch (full state, then deltas) when the desktop mutates its store.
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
  /**
   * `true` when this is the host's default project (set by the host based on
   * `default_project_id`). Distinct from a client's per-connection active
   * project — the host cannot know which project a specific client is on.
   * The renderer's `Project.isActive` stays (set locally by `selectProject`).
   */
  isDefault: boolean
}

/** `GET /projects` response body (wrapped in `IpcResult<T>` by the server). */
export interface ProjectListPayload {
  /** Non-archived + archived summaries (the web list shows both, archived greyed). */
  projects: ProjectSummary[]
  /**
   * The host's default project id (seeds a new web client's initial
   * `activeProjectId`), or `null` when none is set.
   */
  defaultProjectId: string | null
}

/**
 * `set_default_project` WS request payload (client→server) — the explicit
 * host-default change: this updates the host default that new web clients start with, persists to the
 * `FileProjectRegistry` (VPS), and publishes the project state to every
 * `projects` watcher. Mirrors the `set_host_default_project` Tauri command + the
 * `POST /projects/default` HTTP route (transport parity).
 */
export interface SetDefaultProjectRequest {
  /** Target project id (validated switchable: known, not archived, has cwd). */
  projectId: string
}

/**
 * Project id the host stamps on a session no registered project owns (and on
 * persisted sessions that predate project attribution). Mirrors
 * `UNASSIGNED_PROJECT_ID` in `src-tauri/src/acp/session_persistence/types.rs`.
 * Chat history shows these under an "Unassigned" bucket.
 */
export const UNASSIGNED_PROJECT_ID = '__unassigned__'
