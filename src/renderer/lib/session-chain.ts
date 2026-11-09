/**
 * Switch-chain fold (spec-in-chat-agent-switch CAP-8): a session created by
 * an in-chat agent switch carries `continuedFrom`, the durable edge naming
 * the session it continues from. The durable `agent_switch` marker on the
 * SOURCE log stays authoritative; the index edge is the O(1) lookup that
 * lets the history list collapse a chain into ONE row — the terminal (new)
 * session — instead of a row per session the conversation passed through.
 *
 * Pure functions over `SessionIndexEntry[]`: no stores, no React. Build a
 * `SessionChainIndex` once per list derivation with `sessionChainIndex` —
 * every lookup (fold, membership, live id) then runs against the shared
 * deduped continuer map instead of rebuilding it per row.
 */

import type { SessionIndexEntry } from './acp-history-persistence'

/** `Untitled Chat` and `Untitled Chat N` — a folded row prefers a real title. */
export const UNTITLED_PATTERN = /^Untitled Chat( \d+)?$/

/** A folded row keeps the terminal's fields plus its chain membership. */
export interface FoldedSessionEntry extends SessionIndexEntry {
  /** Oldest → newest member ids when this row folds a chain (>1 member). */
  chainIds?: string[]
}

export interface SessionChainIndex {
  entries: readonly SessionIndexEntry[]
  byId: Map<string, SessionIndexEntry>
  /**
   * Winning continuer per source id. A source has at most one well-formed
   * continuer; on a malformed index naming two (a fork), the one created
   * last wins (a switch target is always created after its source), with
   * the id as a deterministic tie-break.
   */
  continuerOf: Map<string, SessionIndexEntry>
  /**
   * Members of any cycle in the deduped continuer graph (A ↔ B). A cycle
   * has no terminal: its members are never hidden and never merge into a
   * neighbor — each keeps its own row and its own data.
   */
  cycleMembers: Set<string>
}

/** Build the shared lookup maps over `entries` once (O(N)). */
export function sessionChainIndex(entries: readonly SessionIndexEntry[]): SessionChainIndex {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
  const continuerOf = new Map<string, SessionIndexEntry>()
  for (const entry of entries) {
    const source = entry.continuedFrom
    if (!source || source === entry.id) continue
    if (!byId.has(source)) continue
    const existing = continuerOf.get(source)
    if (
      existing === undefined ||
      entry.createdAt > existing.createdAt ||
      (entry.createdAt === existing.createdAt && entry.id > existing.id)
    ) {
      continuerOf.set(source, entry)
    }
  }

  // Cycle detection on the deduped continuer graph (classic visiting/done
  // walk): only nodes still on the current path can close a loop.
  const cycleMembers = new Set<string>()
  const state = new Map<string, 1 | 2>() // 1 = on path, 2 = done
  for (const entry of entries) {
    if (state.has(entry.id)) continue
    const path: string[] = []
    let current: string | undefined = entry.id
    while (current !== undefined && !state.has(current)) {
      state.set(current, 1)
      path.push(current)
      current = continuerOf.get(current)?.id
    }
    if (current !== undefined && state.get(current) === 1) {
      for (const node of path.slice(path.indexOf(current))) cycleMembers.add(node)
    }
    for (const node of path) state.set(node, 2)
  }
  return { entries, byId, continuerOf, cycleMembers }
}

/**
 * Ancestor ids of `id`, oldest → newest — only over edges the continuer map
 * kept. A `continuedFrom` source whose deduped winner is someone else (a
 * fork's losing branch) is NOT this chain's ancestor: deleting the loser
 * must not remove the shared source the winner still needs. Cycle members
 * stop the walk so each keeps only its own data.
 */
function ancestorsOf(ix: SessionChainIndex, id: string): string[] {
  const ancestors: string[] = []
  const seen = new Set([id])
  let current = id
  for (;;) {
    const source = ix.byId.get(current)?.continuedFrom
    if (
      source === undefined ||
      source === current ||
      seen.has(source) ||
      !ix.byId.has(source) ||
      ix.cycleMembers.has(source) ||
      ix.continuerOf.get(source)?.id !== current
    ) {
      break
    }
    ancestors.unshift(source)
    seen.add(source)
    current = source
  }
  return ancestors
}

/** Descendant ids of `id`, newest-first-from-id → terminal, over kept edges only. */
function descendantsOf(ix: SessionChainIndex, id: string): string[] {
  const descendants: string[] = []
  const seen = new Set([id])
  let current = id
  for (;;) {
    const next = ix.continuerOf.get(current)
    if (next === undefined || seen.has(next.id) || ix.cycleMembers.has(next.id)) break
    descendants.push(next.id)
    seen.add(next.id)
    current = next.id
  }
  return descendants
}

/**
 * Every member id of `id`'s chain, oldest → newest. `[id]` for a standalone
 * or unknown session. Both directions are walked (backward via `continuedFrom`
 * edges the continuer map kept, forward via that map) so delete can drop the
 * whole conversation whichever member the caller names — while a fork's
 * losing branch never claims the shared ancestors the winner still needs.
 */
export function membersOf(ix: SessionChainIndex, id: string): string[] {
  if (!ix.byId.has(id)) return [id]
  return [...ancestorsOf(ix, id), id, ...descendantsOf(ix, id)]
}

/**
 * The terminal (newest live) session id of `id`'s chain — where an open of
 * any member should land. `id` itself when it is not a chain member or when
 * its chain reaches a cycle member (a pure cycle has no terminal; refusing
 * to resolve keeps every member visible rather than hiding the whole
 * conversation).
 */
export function liveIdOf(ix: SessionChainIndex, id: string): string {
  const seen = new Set([id])
  let current = id
  for (;;) {
    const next = ix.continuerOf.get(current)
    if (next === undefined || seen.has(next.id) || ix.cycleMembers.has(next.id)) return current
    seen.add(next.id)
    current = next.id
  }
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
 * Collapse every switch chain in the index to its terminal member. The
 * surviving row keeps the terminal's identity (opens/reconnects land on
 * the live session) while adopting the chain's merged view: the first real
 * title walking newest → oldest, the summed message count, the oldest
 * creation time, the newest activity, and the ordered agent sequence.
 * Standalone entries pass through untouched; a `continuedFrom` naming an
 * absent or deleted source degrades to a standalone row, never a crash.
 * Multi-member rows carry `chainIds` so delete/active-state/extras-merge
 * reach every absorbed member without a second walk.
 */
export function foldEntries(ix: SessionChainIndex): FoldedSessionEntry[] {
  if (ix.continuerOf.size === 0) return [...ix.entries]
  // Hidden = every NON-cycle entry whose kept continuer is not itself a
  // cycle member. A cycle member's row can absorb nobody, and a chain that
  // dead-ends into a cycle keeps its own row too.
  const hidden = new Set<string>()
  for (const entry of ix.entries) {
    if (ix.cycleMembers.has(entry.id)) continue
    const continuer = ix.continuerOf.get(entry.id)
    if (continuer !== undefined && !ix.cycleMembers.has(continuer.id)) hidden.add(entry.id)
  }
  return ix.entries
    .filter((entry) => !hidden.has(entry.id))
    .map((entry) => {
      const chain: SessionIndexEntry[] = ancestorsOf(ix, entry.id)
        .map((memberId) => ix.byId.get(memberId) as SessionIndexEntry)
        .concat(entry)
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
        agents: mergedAgentSequence(chain) ?? entry.agents,
        chainIds: membersOf(ix, entry.id)
      }
    })
}

// Single-call conveniences: build the index for one lookup (a user action
// like delete or project-switch restore). List derivations should build the
// `SessionChainIndex` once and reuse it across every row instead.
export function chainIds(entries: readonly SessionIndexEntry[], id: string): string[] {
  return membersOf(sessionChainIndex(entries), id)
}

export function liveSessionIdOf(entries: readonly SessionIndexEntry[], id: string): string {
  return liveIdOf(sessionChainIndex(entries), id)
}

export function foldSessionChains(entries: readonly SessionIndexEntry[]): FoldedSessionEntry[] {
  return foldEntries(sessionChainIndex(entries))
}
