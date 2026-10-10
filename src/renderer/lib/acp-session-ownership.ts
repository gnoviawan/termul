/**
 * Agent-chat session → owning project resolution. Pure (takes the acp-store
 * slices it needs) so both the acp-store and renderer hooks/components can
 * share one ownership rule without import cycles.
 */
interface OwnershipState {
  sessions: Readonly<Record<string, { projectId: string } | undefined>>
  sessionIndex: ReadonlyArray<{ id: string; projectId: string }>
}

/**
 * Resolve a session's owning project id from live OR index state. `''`
 * counts as UNKNOWN, not as an owner: `session_created` stubs carry
 * `projectId: ''` until the host attributes them, and treating that as an
 * owner would make the session foreign to every project.
 */
export function sessionOwnerProjectId(
  sessionId: string,
  state: OwnershipState
): string | undefined {
  // Live (hydrated/open) sessions carry projectId; CLOSED history tabs are
  // evicted from `sessions` but stay in `sessionIndex` — the index is the
  // ownership source of truth for them.
  const live = state.sessions[sessionId]?.projectId
  if (live) return live
  return state.sessionIndex.find((entry) => entry.id === sessionId)?.projectId || undefined
}

/**
 * Whether an agent-chat session is KNOWN to belong to a project other than
 * `projectId` — FAIL-OPEN: an id with no ownership data anywhere (index not
 * yet loaded, a session the host has never seen, an unattributed stub) is
 * not foreign. An empty `projectId` (no active project yet) judges nothing
 * foreign either.
 */
export function chatForeignToProject(
  sessionId: string,
  projectId: string,
  state: OwnershipState
): boolean {
  if (!projectId) return false
  const owner = sessionOwnerProjectId(sessionId, state)
  return owner != null && owner !== projectId
}
