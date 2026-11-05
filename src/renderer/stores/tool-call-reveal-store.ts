/**
 * A request to show one tool call card in its chat: the transcript scrolls to
 * it, the turn and work run holding it expand, and the card opens. The status
 * pill's Background rows ask here. A request lapses once the transcript had
 * time to scroll, so a row that mounts later does not act on it.
 */

import { create } from 'zustand'

export interface ToolCallRevealTarget {
  sessionId: string
  toolCallId: string
  nonce: number
}

interface ToolCallRevealState {
  target: ToolCallRevealTarget | null
  reveal: (sessionId: string, toolCallId: string) => void
}

const REVEAL_LAPSE_MS = 2_000

let nextNonce = 0

export const useToolCallRevealStore = create<ToolCallRevealState>((set, get) => ({
  target: null,
  reveal: (sessionId, toolCallId) => {
    nextNonce += 1
    const nonce = nextNonce
    set({ target: { sessionId, toolCallId, nonce } })
    setTimeout(() => {
      if (get().target?.nonce === nonce) set({ target: null })
    }, REVEAL_LAPSE_MS)
  }
}))

/** The nonce of a pending request whose tool call `matches`, else null. */
export function useToolCallReveal(matches: (toolCallId: string) => boolean): number | null {
  return useToolCallRevealStore((s) =>
    s.target && matches(s.target.toolCallId) ? s.target.nonce : null
  )
}
