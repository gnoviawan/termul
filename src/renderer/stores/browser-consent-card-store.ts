/**
 * Mount registry for the in-chat browser consent card
 * (spec-acp-browser-automation-v2 CAP-5).
 *
 * `AgentChatPanel` registers its sessionId while it hosts a VISIBLE card —
 * the panel is mounted (and its card painted) whenever the chat tab exists
 * in the pane tree, but the card is only actually on screen when the chat
 * tab is its pane's active tab (PaneContent keeps hidden tabs mounted but
 * CSS-invisible). Keying on mount alone would leave dead states where the
 * panel holds a hidden card while the root `BrowserConsentCardHost` also
 * renders one, or conversely no reachable surface at all.
 *
 * The root host renders fallback cards only for pending consents whose
 * session is NOT registered here (non-workspace routes, SSH mode, warm-pool
 * sessions without a chat tab, chat tabs hidden behind another tab) and
 * never while the consent strip is hosting.
 */

import { create } from 'zustand'

interface ConsentCardHostState {
  hostedSessionIds: ReadonlySet<string>
  register: (sessionId: string) => void
  unregister: (sessionId: string) => void
}

export const useConsentCardHost = create<ConsentCardHostState>((set) => ({
  hostedSessionIds: new Set<string>(),
  register: (sessionId) =>
    set((s) => {
      const next = new Set(s.hostedSessionIds)
      next.add(sessionId)
      return { hostedSessionIds: next }
    }),
  unregister: (sessionId) =>
    set((s) => {
      const next = new Set(s.hostedSessionIds)
      next.delete(sessionId)
      return { hostedSessionIds: next }
    })
}))
