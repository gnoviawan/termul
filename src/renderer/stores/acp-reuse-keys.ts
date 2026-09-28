/**
 * Single owner of the agent reuse-key format.
 *
 * Canonical keys are `configId\0cwd` (two NUL-separated segments) — see
 * {@link agentReuseKey}. Two writers emit a DETACHED key with a third segment
 * (`configId\0cwd\0agentId`) to keep a superseded agent process resolvable for
 * live chat history, model changes, and cleanup, while guaranteeing the key is
 * NEVER reused for a new chat preparation: its third segment is an agent id,
 * so treating the key as `configId\0cwd` would corrupt the working directory.
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
 * Canonical reuse key for a configured agent + working directory: the identity
 * of a live agent *process* (the agent process is MCP-agnostic; only the
 * session folds MCP selection in — see `prepareChatKey` in `acp-store.ts`).
 */
export function agentReuseKey(configId: string, cwd: string): string {
  return `${configId}${NUL}${cwd.trim()}`
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
 * True when `key` carries a detached third segment. Only meaningful for
 * `configToLiveAgent` keys — prepare-chat keys ALWAYS have a third segment
 * (the `mcpKey`), which is not a detach marker (see the module docstring).
 */
export function isDetachedReuseKey(key: string): boolean {
  return key.split(NUL).length > 2
}

/** A reuse key parsed into its segments. */
export interface ParsedReuseKey {
  configId: string
  cwd: string
  /**
   * The detached agent id, present only for detached keys
   * (`configId\0cwd\0agentId`). When parsing a prepare-chat key instead, this
   * field carries the `mcpKey` segment — callers know which domain their key
   * belongs to and must not treat a prepare key as detached.
   */
  detachedAgentId?: string
}

/**
 * Parse a reuse key, explicitly modeling the optional detached segment so
 * consumers never re-derive segments with ad-hoc `split('\0')` calls (which is
 * how the corrupted-cwd prepare bug slipped in — see `completeBrowserAuth`).
 */
export function parseReuseKey(key: string): ParsedReuseKey {
  const [configId = '', cwd = '', thirdSegment] = key.split(NUL)
  return thirdSegment !== undefined
    ? { configId, cwd, detachedAgentId: thirdSegment }
    : { configId, cwd }
}
