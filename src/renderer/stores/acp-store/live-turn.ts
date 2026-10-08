/**
 * Reload recovery for a turn the host is still running (issue #882).
 *
 * `status: 'active'` on a persisted session means "not closed", including an
 * idle chat, so it is not proof a prompt is in flight. `turnActive` is.
 * `ACP_REOPEN_TURN_ACTIVE` from load/resume is the backstop when metadata
 * omitted the flag. Neither path may weaken the host's single-owner guard.
 */

export function isLaunchPlaceholderSessionId(sessionId: string): boolean {
  return sessionId.startsWith('launch-')
}

/** True only when host metadata says a prompt turn is still running. */
export function persistedTurnIsLive(meta: { turnActive?: boolean } | null | undefined): boolean {
  return meta?.turnActive === true
}

/**
 * Desktop invoke rejects with the plain string. The web socket wraps it in
 * `AcpTransportError`, whose message (and `String(err)`) still contains the
 * guard token. Match the text — the wire code is a generic `not_implemented`.
 */
export function isReopenTurnActiveError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return message.includes('ACP_REOPEN_TURN_ACTIVE')
}

/**
 * `ACP_SESSION_OWNED_BY_OTHER` is rejected when a DIFFERENT live agent owns
 * the session and still has a turn in flight — in-band proof the turn is
 * live, with the owner named in the message. A reopen that lands here should
 * re-adopt the owner and attach, not paint "Resume failed".
 */
export function isSessionOwnedByOtherError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return message.includes('ACP_SESSION_OWNED_BY_OTHER')
}

/**
 * Index membership is what makes a session real. `launch-` is a renderer
 * placeholder convention, not a reserved session-id prefix — an indexed
 * chat with that prefix must still be kept.
 */
export function isIndexedRealSession(index: readonly { id: string }[], sessionId: string): boolean {
  return index.some((entry) => entry.id === sessionId)
}

type LiveLaunchLookup = (sessionId: string) => boolean

let liveLaunchLookup: LiveLaunchLookup = () => false

/** The ACP store registers this so editor restore can see live launch tabs. */
export function setLiveLaunchSessionLookup(lookup: LiveLaunchLookup): void {
  liveLaunchLookup = lookup
}

/** True when a `launch-*` id still has a session record or a launching flag. */
export function isLiveLaunchSession(sessionId: string): boolean {
  return liveLaunchLookup(sessionId)
}

type PlaceholderNotedListener = () => void

let placeholderNotedListener: PlaceholderNotedListener | null = null

/** Re-run launch recovery once placeholders are actually recorded. */
export function setLaunchPlaceholderNotedListener(listener: PlaceholderNotedListener | null): void {
  placeholderNotedListener = listener
}

const droppedLaunchPlaceholders = new Map<string, Set<string>>()

/** Remember launch-* tabs dropped during workspace restore, per project. */
export function noteDroppedLaunchPlaceholders(projectId: string, ids: readonly string[]): void {
  if (!projectId) return
  const placeholders = ids.filter((id) => isLaunchPlaceholderSessionId(id))
  if (placeholders.length === 0) return
  const noted = droppedLaunchPlaceholders.get(projectId) ?? new Set<string>()
  for (const id of placeholders) noted.add(id)
  droppedLaunchPlaceholders.set(projectId, noted)
  placeholderNotedListener?.()
}

/** Take one project's drops and leave every other project's notes in place. */
export function takeDroppedLaunchPlaceholders(projectId: string): string[] {
  const noted = droppedLaunchPlaceholders.get(projectId)
  if (!noted || noted.size === 0) return []
  droppedLaunchPlaceholders.delete(projectId)
  return [...noted]
}

/** Take and clear every project that dropped launch placeholders this restore. */
export function takeAllDroppedLaunchPlaceholders(): Array<{ projectId: string; count: number }> {
  const drops = [...droppedLaunchPlaceholders.entries()].map(([projectId, ids]) => ({
    projectId,
    count: ids.size
  }))
  droppedLaunchPlaceholders.clear()
  return drops
}

export function _resetDroppedLaunchPlaceholdersForTesting(): void {
  droppedLaunchPlaceholders.clear()
}

export function partitionRestoredAgentChatIds(ids: readonly string[]): {
  placeholders: string[]
  sessionIds: string[]
} {
  const placeholders: string[] = []
  const sessionIds: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (isLaunchPlaceholderSessionId(id)) placeholders.push(id)
    else sessionIds.push(id)
  }
  return { placeholders, sessionIds }
}

export interface LaunchRecoveryCandidate {
  id: string
  projectId: string
  status: string
  turnActive?: boolean
  lastActivityAt: number
  discovered?: boolean
}

/**
 * Pick persisted sessions to open after launch-* tabs were dropped.
 * Prefer chats whose index row says the turn is still live. Otherwise open
 * the single status-active chat for the project — several idle-active chats
 * are ambiguous, and guessing would surface the wrong one.
 */
export function selectLaunchRecoverySessions(
  entries: readonly LaunchRecoveryCandidate[],
  projectId: string,
  openIds: ReadonlySet<string>,
  droppedCount: number
): LaunchRecoveryCandidate[] {
  if (droppedCount <= 0) return []
  const candidates = entries.filter(
    (entry) => entry.projectId === projectId && entry.discovered !== true && !openIds.has(entry.id)
  )
  const byRecent = (a: LaunchRecoveryCandidate, b: LaunchRecoveryCandidate): number =>
    b.lastActivityAt - a.lastActivityAt
  const live = candidates.filter((entry) => entry.turnActive === true).sort(byRecent)
  if (live.length > 0) return live.slice(0, droppedCount)
  const active = candidates.filter((entry) => entry.status === 'active').sort(byRecent)
  if (active.length === 1) return active
  return []
}
