/**
 * TerminalRendererPool
 *
 * Singleton managing a fixed-size pool of pre-warmed xterm.js Terminal instances.
 * Slots are acquired/released as panes become visible/hidden, preventing the cost
 * of creating/destroying xterm instances (WebGL context, font atlas, DOM subtree)
 * on every pane switch.
 *
 * Pool size: 5 slots (POOL_MAX_SIZE). When all slots are busy and a new pane
 * requests one, the lowest-priority slot is evicted. Eviction serializes the
 * scrollback via @xterm/addon-serialize for replay when the slot is re-acquired.
 *
 * Inactive slot host elements live in a hidden recycler <div> appended to
 * document.body, using `contain: strict` for layout isolation.
 */

import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { getTerminalOptions } from './terminal-config'

/** Maximum number of concurrent xterm.js instances. */
export const POOL_MAX_SIZE = 5

export interface PoolSlot {
  /** Unique slot identifier (0..POOL_MAX_SIZE-1). */
  readonly id: number

  /** The xterm.js Terminal instance. */
  readonly term: Terminal

  /** Fit addon for auto-sizing. */
  readonly fitAddon: FitAddon

  /** Search addon. */
  readonly searchAddon: SearchAddon

  /** Serialize addon for scrollback capture on eviction. */
  readonly serializeAddon: SerializeAddon

  /** WebGL addon (null if WebGL failed or disabled). */
  webglAddon: WebglAddon | null

  /** Host div that the terminal is opened in. Lives in the recycler when idle. */
  readonly host: HTMLDivElement

  /** The leaf/pane ID currently bound to this slot, or null if free. */
  currentLeafId: string | null

  /** Timestamp of last acquire/release for eviction scoring. */
  lastUsedAt: number

  /** Whether the slot is in alt-screen mode (+100 eviction penalty). */
  isAltScreen: boolean

  /** Whether the slot is currently in focus (+10 eviction penalty). */
  isFocused: boolean

  /** Serialized scrollback captured on eviction, to replay on re-acquire. */
  snapshot: string | null
}

/** Eviction scores for different slot states. */
const EVICT_ALT_SCREEN_PENALTY = 100
const EVICT_FOCUSED_PENALTY = 10

/** Shared slot array (pool singleton). */
const poolSlots: PoolSlot[] = []

/** Recycler container cached reference. */
let recyclerContainer: HTMLDivElement | null = null

/**
 * Get or create the shared recycler <div>.
 * This div hosts off-screen slot elements.
 */
function getRecyclerContainer(): HTMLDivElement {
  if (!recyclerContainer) {
    recyclerContainer = document.createElement('div')
    recyclerContainer.setAttribute('data-termul-recycler', '')
    recyclerContainer.style.cssText = `
			position: fixed;
			left: -99999px;
			top: -99999px;
			width: 1024px;
			height: 768px;
			overflow: hidden;
			pointer-events: none;
			contain: strict;
		`
    document.body.appendChild(recyclerContainer)
  }
  return recyclerContainer
}

/**
 * Create a fully-initialized pool slot.
 * Opens the terminal into an off-screen host div in the recycler.
 */
function createSlot(id: number, platform: string): PoolSlot {
  const options = getTerminalOptions(platform)

  const term = new Terminal(options)
  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  const serializeAddon = new SerializeAddon()

  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(serializeAddon)

  // Create host div
  const host = document.createElement('div')
  host.style.cssText = `
		position: fixed;
		left: -99999px;
		top: -99999px;
		width: 1024px;
		height: 768px;
		overflow: hidden;
		pointer-events: none;
		contain: strict;
	`

  // Add host to recycler
  const recycler = getRecyclerContainer()
  recycler.appendChild(host)

  term.open(host)

  // Try WebGL addon
  let webglAddon: WebglAddon | null = null
  try {
    webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      webglAddon?.dispose()
      // Find the slot and update its webglAddon ref
      const slot = poolSlots.find((s) => s.webglAddon === webglAddon)
      if (slot) slot.webglAddon = null
    })
    term.loadAddon(webglAddon)
  } catch {
    webglAddon = null
  }

  return {
    id,
    term,
    fitAddon,
    searchAddon,
    serializeAddon,
    webglAddon,
    host,
    currentLeafId: null,
    lastUsedAt: 0,
    isAltScreen: false,
    isFocused: false,
    snapshot: null
  }
}

export interface SlotAcquireOptions {
  /** Optional platform string to use for Terminal construction. */
  platform?: string
  /** Optional initial config values to apply if creating a new slot. */
  initialOptions?: {
    fontFamily?: string
    fontSize?: number
    scrollback?: number
  }
}

/**
 * Acquire a slot for a given leaf/pane.
 *
 * 1. If a slot is already bound to this leafId, rewire it to the container.
 * 2. If a free slot exists, bind and return it.
 * 3. If pool isn't full, create a new slot.
 * 4. If pool is full, evict the lowest-priority slot.
 *
 * @returns The acquired slot, or null if all slots are busy and eviction failed.
 */
export function acquireSlot(
  leafId: string,
  container: HTMLElement,
  options: SlotAcquireOptions = {}
): PoolSlot | null {
  // 1. Check if this leaf already has a bound slot
  const existing = poolSlots.find((s) => s.currentLeafId === leafId)
  if (existing) {
    existing.lastUsedAt = Date.now()

    // Rewire host div to new container
    existing.host.remove()
    container.appendChild(existing.host)
    resetHostStyleForActive(existing.host)

    // Replay snapshot if available
    if (existing.snapshot) {
      try {
        existing.term.write(existing.snapshot)
      } catch {
        // Ignore write errors during re-acquire
      }
      existing.snapshot = null
    }

    return existing
  }

  // 2. Find a free slot
  const freeSlot = poolSlots.find((s) => s.currentLeafId === null)
  if (freeSlot) {
    return bindSlot(freeSlot, leafId, container)
  }

  // 3. Check if pool has capacity
  if (poolSlots.length < POOL_MAX_SIZE) {
    const platform =
      options.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '')
    const newSlot = createSlot(poolSlots.length, platform)

    // Apply initial options
    const opts = options.initialOptions
    if (opts) {
      if (opts.fontFamily !== undefined) newSlot.term.options.fontFamily = opts.fontFamily
      if (opts.fontSize !== undefined) newSlot.term.options.fontSize = opts.fontSize
      if (opts.scrollback !== undefined) newSlot.term.options.scrollback = opts.scrollback
    }

    poolSlots.push(newSlot)
    return bindSlot(newSlot, leafId, container)
  }

  // 4. Pool full — evict lowest-priority slot
  const evictable = findEvictionCandidate()
  if (evictable) {
    return evictAndAcquire(evictable, leafId, container)
  }

  console.warn('[TerminalRendererPool] All slots busy and no eviction candidate found')
  return null
}

/** Reset host div styling for active (visible) display. */
function resetHostStyleForActive(host: HTMLDivElement): void {
  host.style.position = 'relative'
  host.style.left = ''
  host.style.top = ''
  host.style.width = '100%'
  host.style.height = '100%'
  host.style.contain = ''
  host.style.overflow = ''
}

/** Reset host div styling for recycler (off-screen) storage. */
function resetHostStyleForRecycler(host: HTMLDivElement): void {
  host.style.cssText = `
		position: fixed;
		left: -99999px;
		top: -99999px;
		width: 1024px;
		height: 768px;
		overflow: hidden;
		pointer-events: none;
		contain: strict;
	`
}

/**
 * Bind a slot to a leaf/pane and move its host div to the given container.
 */
function bindSlot(slot: PoolSlot, leafId: string, container: HTMLElement): PoolSlot {
  slot.currentLeafId = leafId
  slot.lastUsedAt = Date.now()

  // Clear any snapshot from previous session to prevent cross-leaf leakage
  slot.snapshot = null

  slot.host.remove()
  container.appendChild(slot.host)
  resetHostStyleForActive(slot.host)

  return slot
}

/**
 * Release a slot bound to the given leaf/pane.
 * Moves the host div back to the recycler and serializes scrollback.
 */
export function releaseSlot(leafId: string): void {
  const slot = poolSlots.find((s) => s.currentLeafId === leafId)
  if (!slot) return

  slot.lastUsedAt = Date.now()
  slot.isFocused = false

  // Serialize scrollback before putting back in recycler
  // Skip if in alt-screen mode (serialization doesn't capture it well)
  if (!slot.isAltScreen) {
    try {
      slot.snapshot = slot.serializeAddon.serialize({
        scrollback: 5000
      })
    } catch {
      slot.snapshot = null
    }
  } else {
    slot.snapshot = null
  }

  // Detach from container and move to recycler
  slot.host.remove()
  resetHostStyleForRecycler(slot.host)
  const recycler = getRecyclerContainer()
  recycler.appendChild(slot.host)

  slot.currentLeafId = null
}

/**
 * Calculate eviction priority score for a slot.
 * LOWER score = more likely to be evicted.
 */
function evictionScore(slot: PoolSlot): number {
  let score = 0
  score += slot.isAltScreen ? EVICT_ALT_SCREEN_PENALTY : 0
  score += slot.isFocused ? EVICT_FOCUSED_PENALTY : 0
  // Time-based: slots used more recently get higher score (harder to evict)
  const age = Date.now() - slot.lastUsedAt
  score += Math.max(0, 60000 - age) / 60000 // up to 1 point for recency within 1 minute
  return score
}

/**
 * Find the slot with the lowest eviction priority.
 * Prefers evicting non-alt-screen slots.
 */
function findEvictionCandidate(): PoolSlot | null {
  if (poolSlots.length === 0) return null

  // Try to find a non-alt-screen slot first
  const nonAltScreenSlots = poolSlots.filter((s) => s.currentLeafId !== null && !s.isAltScreen)
  const candidatePool =
    nonAltScreenSlots.length > 0
      ? nonAltScreenSlots
      : poolSlots.filter((s) => s.currentLeafId !== null)

  if (candidatePool.length === 0) return null

  return candidatePool.reduce((lowest, slot) =>
    evictionScore(slot) < evictionScore(lowest) ? slot : lowest
  )
}

/**
 * Evict a slot and immediately bind it to a new leaf.
 */
function evictAndAcquire(slot: PoolSlot, leafId: string, container: HTMLElement): PoolSlot {
  // Serialize the evicted slot's scrollback
  if (!slot.isAltScreen) {
    try {
      slot.snapshot = slot.serializeAddon.serialize({
        scrollback: 5000
      })
    } catch {
      slot.snapshot = null
    }
  }

  // Detach from old container
  slot.host?.remove()

  // Clear state for new session
  slot.snapshot = null
  slot.isAltScreen = false
  slot.isFocused = false
  slot.currentLeafId = null

  // Clear terminal for new session
  slot.term.reset()

  return bindSlot(slot, leafId, container)
}

/**
 * Mark a slot as focused (increases eviction priority).
 */
export function markSlotFocused(leafId: string): void {
  const slot = poolSlots.find((s) => s.currentLeafId === leafId)
  if (slot) {
    slot.isFocused = true
    slot.lastUsedAt = Date.now()
  }
}

/**
 * Mark a slot as blurred (decreases eviction priority).
 */
export function markSlotBlurred(leafId: string): void {
  const slot = poolSlots.find((s) => s.currentLeafId === leafId)
  if (slot) {
    slot.isFocused = false
  }
}

/**
 * Mark a slot's alt-screen state. Called when the terminal enters/exits
 * alternate screen mode (e.g. vim, less).
 */
export function markSlotAltScreen(leafId: string, isAltScreen: boolean): void {
  const slot = poolSlots.find((s) => s.currentLeafId === leafId)
  if (slot) {
    slot.isAltScreen = isAltScreen
  }
}

/**
 * Get the slot bound to a leafId, or null.
 */
export function getSlot(leafId: string): PoolSlot | null {
  return poolSlots.find((s) => s.currentLeafId === leafId) ?? null
}

/**
 * Get pool statistics (for debugging).
 */
export function getPoolStats(): {
  totalSlots: number
  activeSlots: number
  freeSlots: number
  boundLeaves: string[]
} {
  return {
    totalSlots: poolSlots.length,
    activeSlots: poolSlots.filter((s) => s.currentLeafId !== null).length,
    freeSlots: poolSlots.filter((s) => s.currentLeafId === null).length,
    boundLeaves: poolSlots.filter((s) => s.currentLeafId !== null).map((s) => s.currentLeafId!)
  }
}

/**
 * Clear the pool and dispose all terminal instances.
 * Used for testing and app-wide cleanup.
 */
export function clearPool(): void {
  for (const slot of poolSlots) {
    slot.host?.remove()
    try {
      slot.term.dispose()
    } catch {
      // Ignore disposal errors
    }
  }
  poolSlots.length = 0
  if (recyclerContainer) {
    recyclerContainer.remove()
    recyclerContainer = null
  }
}
