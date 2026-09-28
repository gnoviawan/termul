import { useRef } from 'react'
import type { SessionId } from '@/lib/acp-api'

/**
 * A row only counts as "just arrived" for this long. Virtualized rows that
 * unmount and remount later (scroll away and back, collapse and reopen) are
 * outside the window, so they do not replay their entrance.
 */
export const ENTER_WINDOW_MS = 1000

export interface EnterTracker {
  /** True while `id` is a live arrival that has not yet had its entrance window. */
  animate: (id: string) => boolean
  /** Position of `id` inside the render that first showed it (0 for the first new row). */
  staggerIndex: (id: string) => number
}

interface Arrival {
  index: number
  at: number
}

interface TrackerState {
  sessionId: SessionId
  seen: Set<string>
  arrivals: Map<string, Arrival>
}

/**
 * Tracks which timeline ids arrived live, after the first paint of a session.
 * - Ids present on the first render of a session (restored history) never animate.
 * - Ids prepended before already-seen rows (older history loaded on scroll-up) never animate.
 * - Ids appended after the live edge animate once, with a per-burst stagger index.
 *
 * The baseline resets during render on a session switch, so the first frame of
 * the new session already treats its history as seen.
 */
export function useEnterTracker(sessionId: SessionId, ids: readonly string[]): EnterTracker {
  const stateRef = useRef<TrackerState | null>(null)
  const now = Date.now()

  let current = stateRef.current
  if (current === null || current.sessionId !== sessionId) {
    current = { sessionId, seen: new Set(ids), arrivals: new Map() }
    stateRef.current = current
  } else {
    let lastSeenIndex = -1
    for (let i = ids.length - 1; i >= 0; i--) {
      if (current.seen.has(ids[i])) {
        lastSeenIndex = i
        break
      }
    }
    let burstIndex = 0
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (current.seen.has(id)) continue
      current.seen.add(id)
      if (i > lastSeenIndex) current.arrivals.set(id, { index: burstIndex++, at: now })
    }
    for (const [id, arrival] of current.arrivals) {
      if (now - arrival.at >= ENTER_WINDOW_MS) current.arrivals.delete(id)
    }
  }

  const arrivals = current.arrivals
  return {
    animate: (id) => {
      const arrival = arrivals.get(id)
      return arrival !== undefined && Date.now() - arrival.at < ENTER_WINDOW_MS
    },
    staggerIndex: (id) => arrivals.get(id)?.index ?? 0
  }
}
