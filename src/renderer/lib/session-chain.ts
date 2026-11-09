/**
 * Switch-chain fold (spec-in-chat-agent-switch CAP-8): a session created by
 * an in-chat agent switch carries `continuedFrom`, the durable edge naming
 * the session it continues from. The durable `agent_switch` marker on the
 * SOURCE log stays authoritative; the index edge is the O(1) lookup that
 * lets the history list collapse a chain into ONE row — the terminal (new)
 * session — instead of a row per session the conversation passed through.
 *
 * Pure functions over `SessionIndexEntry[]`: no stores, no React.
 */

import type { SessionIndexEntry } from './acp-history-persistence'

/** `Untitled Chat` and `Untitled Chat N` — a folded row prefers a real title. */
const UNTITLED_PATTERN = /^Untitled Chat( \d+)?$/

/**
 * Forward continuation map: source session id → the session that continues
 * it. A source has at most one well-formed continuer; on a malformed index
 * naming two, the one created last wins (a switch target is always created
 * after its source), with the id as a deterministic tie-break.
 */
function continuerMap(entries: readonly SessionIndexEntry[]): Map<string, string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
  const continuerOf = new Map<string, string>()
  for (const entry of entries) {
    const source = entry.continuedFrom
    if (!source || source === entry.id || !byId.has(source)) continue
    const current = continuerOf.get(source)
    if (current === undefined) {
      continuerOf.set(source, entry.id)
      continue
    }
    const existing = byId.get(current)
    if (
      existing !== undefined &&
      (entry.createdAt > existing.createdAt ||
        (entry.createdAt === existing.createdAt && entry.id > existing.id))
    ) {
      continuerOf.set(source, entry.id)
    }
  }
  return continuerOf
}

/**
 * The terminal (newest live) session id of `id`'s chain — where an open of
 * any member should land. `id` itself when it is not a chain member or when
 * its chain cycles back (a pure cycle has no terminal; refusing to resolve
 * keeps every member visible rather than hiding the whole conversation).
 */
export function liveSessionIdOf(entries: readonly SessionIndexEntry[], id: string): string {
  const continuerOf = continuerMap(entries)
  const seen = new Set<string>()
  let current = id
  while (continuerOf.has(current) && !seen.has(current)) {
    seen.add(current)
    current = continuerOf.get(current) as string
  }
  return current
}

/**
 * Every member id of `id`'s chain, oldest → newest. `[id]` for a standalone
 * session. Both directions are walked (backward via `continuedFrom`,
 * forward via the continuer map) so delete can drop the whole conversation
 * whichever member the caller names.
 */
export function chainIds(entries: readonly SessionIndexEntry[], id: string): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
  const continuerOf = continuerMap(entries)
  const seen = new Set<string>([id])
  // Backward: ancestors oldest → newest. Forward: descendants from id — the
  // row's own membership, so a fork's row never claims its sibling branch.
  const ancestors: string[] = []
  let current = id
  while (true) {
    const source = byId.get(current)?.continuedFrom
    if (source === undefined || source === current || seen.has(source) || !byId.has(source)) break
    ancestors.unshift(source)
    seen.add(source)
    current = source
  }
  const descendants: string[] = []
  current = id
  while (continuerOf.has(current)) {
    const next = continuerOf.get(current) as string
    if (seen.has(next)) break
    seen.add(next)
    descendants.push(next)
    current = next
  }
  return [...ancestors, id, ...descendants]
}

/** Ordered, consecutive-deduped config-id sequence across the chain. */
function mergedAgentSequence(chain: readonly SessionIndexEntry[]): string[] | undefined {
  const agents: string[] = []
  for (const member of chain) {
    const sequence = member.agents ?? (member.agentConfigId ? [member.agentConfigId] : [])
    for (const configId of sequence) {
      if (agents[agents.length - 1] !== configId) agents.push(configId)
    }
  }
  return agents.length > 1 ? agents : undefined
}

/**
 * Collapse every switch chain in `entries` to its terminal member. The
 * surviving row keeps the terminal's identity (opens/reconnects land on
 * the live session) while adopting the chain's merged view: the first real
 * title walking newest → oldest, the summed message count, the oldest
 * creation time, the newest activity, and the ordered agent sequence.
 * Standalone entries pass through untouched; a `continuedFrom` naming an
 * absent or deleted source degrades to a standalone row, never a crash.
 */
export function foldSessionChains(entries: readonly SessionIndexEntry[]): SessionIndexEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
  const continuerOf = continuerMap(entries)
  if (continuerOf.size === 0) return [...entries]
  // Hidden = every source whose continuer walk reaches a DISTINCT terminal.
  // A pure cycle (A ↔ B) never reaches one — its members stay listed rather
  // than vanishing.
  const hidden = new Set<string>()
  for (const entry of entries) {
    const seen = new Set<string>([entry.id])
    let terminal = entry.id
    while (continuerOf.has(terminal)) {
      const next = continuerOf.get(terminal) as string
      if (seen.has(next)) {
        terminal = entry.id // ran into a cycle: no terminal, hide nothing
        break
      }
      seen.add(next)
      terminal = next
    }
    if (terminal !== entry.id) hidden.add(entry.id)
  }
  return entries
    .filter((entry) => !hidden.has(entry.id))
    .map((entry) => {
      // Backward walk from this (possibly terminal) entry to its chain root.
      const chain: SessionIndexEntry[] = [entry]
      const seen = new Set([entry.id])
      let current = entry
      while (
        current.continuedFrom !== undefined &&
        current.continuedFrom !== current.id &&
        !seen.has(current.continuedFrom) &&
        byId.has(current.continuedFrom)
      ) {
        const source = byId.get(current.continuedFrom) as SessionIndexEntry
        chain.unshift(source)
        seen.add(source.id)
        current = source
      }
      if (chain.length === 1) return entry
      const title =
        [...chain].reverse().find((member) => !UNTITLED_PATTERN.test(member.title.trim()))?.title ??
        entry.title
      return {
        ...entry,
        title,
        messageCount: chain.reduce((sum, member) => sum + member.messageCount, 0),
        createdAt: Math.min(...chain.map((member) => member.createdAt)),
        lastActivityAt: Math.max(...chain.map((member) => member.lastActivityAt)),
        lastSeq: Math.max(...chain.map((member) => member.lastSeq ?? 0)),
        agents: mergedAgentSequence(chain) ?? entry.agents
      }
    })
}
