/**
 * Single owner of the agent reuse-key format.
 *
 * Canonical keys are `configId\0cwd` (two NUL-separated segments) — see
 * {@link agentReuseKey}. A Project-scoped canonical key inserts a `project`
 * marker: `configId\0cwd\0project\0projectId`. The marker keeps that key
 * distinct from a detached key, whose extra segment is an agent id.
 * Two writers emit a DETACHED key by appending the agent id
 * (`configId\0cwd\0agentId`, or `configId\0cwd\0project\0projectId\0agentId`)
 * to keep a superseded agent process resolvable for live chat history, model
 * changes, and cleanup, while guaranteeing the key is NEVER reused for a new
 * chat preparation.
 * Detached keys are produced by `ensureLiveAgent` (Factory session isolation)
 * and `detachAgentForNewCredentials`.
 *
 * Documented exception: `prepareChatError` / `prepareChatKey` keys append a
 * third `\0mcpKey` segment (empty when no MCP selection) on top of a canonical
 * reuse key. A third segment alone therefore does not prove a key is detached —
 * {@link isDetachedReuseKey} is only meaningful for `configToLiveAgent` keys
 * (prepare keys are always the 3-segment prepare format and are never fed to
 * these predicates). `configId` never contains `\0`, so
 * {@link configIdFromReuseKey} can always recover it.
 */

const NUL = '\0'

/**
 * Marker segment that distinguishes a Project-scoped canonical key from a
 * detached key. The following segment is the Project id.
 */
const PROJECT_SEGMENT = 'project'

/**
 * Canonical reuse key for a configured agent + working directory: the identity
 * of a live agent *process* (the agent process is MCP-agnostic; only the
 * session folds MCP selection in — see `prepareChatKey` in `acp-store.ts`).
 *
 * `projectId` selects the Claude Account of a managed Claude agent. Two
 * Projects that share a cwd must not share that process, so a non-empty
 * Project id is part of the key.
 */
export function agentReuseKey(configId: string, cwd: string, projectId?: string | null): string {
  const base = `${configId}${NUL}${cwd.trim()}`
  const project = projectId?.trim() ?? ''
  if (project.length === 0) return base
  return `${base}${NUL}${PROJECT_SEGMENT}${NUL}${project}`
}

/** Recover the `configId` from an {@link agentReuseKey} (split on first NUL). */
export function configIdFromReuseKey(key: string): string {
  const nul = key.indexOf(NUL)
  return nul === -1 ? key : key.slice(0, nul)
}

/**
 * Detached reuse key: keeps `agentId` resolvable for live chat history, model
 * changes, and cleanup, without allowing the next prepare to reuse the
 * canonical key (its third segment is an agent id, not a cwd).
 */
export function detachedReuseKey(reuseKey: string, agentId: string): string {
  return `${reuseKey}${NUL}${agentId}`
}

/**
 * True when `key` carries a detached agent-id segment. Only meaningful for
 * `configToLiveAgent` keys — prepare-chat keys ALWAYS have a third segment
 * (the `mcpKey`), which is not a detach marker (see the module docstring).
 * A `project` marker segment is canonical, not detached.
 */
export function isDetachedReuseKey(key: string): boolean {
  const parts = key.split(NUL)
  // `configId\0cwd\0project\0projectId` is canonical. Detached appends agentId.
  if (parts[2] === PROJECT_SEGMENT) return parts.length > 4
  return parts.length > 2
}

/** A reuse key parsed into its segments. */
export interface ParsedReuseKey {
  configId: string
  cwd: string
  /**
   * Project id for a Project-scoped key (`configId\0cwd\0project\0projectId`).
   * Absent on the two-segment canonical key.
   */
  projectId?: string
  /**
   * The detached agent id, present only for detached keys
   * (`configId\0cwd\0agentId`, or with a Project segment before the agent id).
   * When parsing a prepare-chat key instead, this field carries the `mcpKey`
   * segment — callers know which domain their key belongs to and must not
   * treat a prepare key as detached.
   */
  detachedAgentId?: string
}

/**
 * Parse a reuse key, explicitly modeling the optional detached segment so
 * consumers never re-derive segments with ad-hoc `split('\0')` calls (which is
 * how the corrupted-cwd prepare bug slipped in — see `completeBrowserAuth`).
 */
export function parseReuseKey(key: string): ParsedReuseKey {
  const parts = key.split(NUL)
  const configId = parts[0] ?? ''
  const cwd = parts[1] ?? ''
  if (parts.length <= 2) return { configId, cwd }
  if (parts[2] === PROJECT_SEGMENT) {
    const projectId = parts[3] ?? ''
    const detachedAgentId = parts[4]
    return detachedAgentId !== undefined
      ? { configId, cwd, projectId, detachedAgentId }
      : { configId, cwd, projectId }
  }
  return { configId, cwd, detachedAgentId: parts[2] }
}
