/**
 * Which sessions an agent is driving a browser tab for, and which of them
 * the user stopped. Fed by `acp:browser_agent_tab` and
 * `acp:browser_stop_changed` on every client, so the Stop indicator shows
 * on desktop and remote alike.
 */

import { create } from 'zustand'

interface BrowserControlState {
  /** Agent browser tab id → the session that owns it. */
  tabSessions: Readonly<Record<string, string>>
  /** Sessions latched by Stop until the user's next message. */
  stoppedSessions: Readonly<Record<string, true>>
  trackAgentTab: (tabId: string, sessionId: string) => void
  untrackAgentTab: (tabId: string) => void
  setStopped: (sessionId: string, stopped: boolean) => void
  forgetSession: (sessionId: string) => void
}

export const useBrowserControlStore = create<BrowserControlState>((set) => ({
  tabSessions: {},
  stoppedSessions: {},
  trackAgentTab: (tabId, sessionId) =>
    set((s) =>
      s.tabSessions[tabId] === sessionId
        ? s
        : { tabSessions: { ...s.tabSessions, [tabId]: sessionId } }
    ),
  untrackAgentTab: (tabId) =>
    set((s) => {
      if (!(tabId in s.tabSessions)) return s
      const { [tabId]: _gone, ...tabSessions } = s.tabSessions
      return { tabSessions }
    }),
  setStopped: (sessionId, stopped) =>
    set((s) => {
      if (stopped === Boolean(s.stoppedSessions[sessionId])) return s
      if (stopped) return { stoppedSessions: { ...s.stoppedSessions, [sessionId]: true } }
      const { [sessionId]: _gone, ...stoppedSessions } = s.stoppedSessions
      return { stoppedSessions }
    }),
  forgetSession: (sessionId) =>
    set((s) => ({
      tabSessions: Object.fromEntries(
        Object.entries(s.tabSessions).filter(([, owner]) => owner !== sessionId)
      ),
      stoppedSessions: Object.fromEntries(
        Object.entries(s.stoppedSessions).filter(([id]) => id !== sessionId)
      )
    }))
}))

/** Whether an agent drives at least one browser tab for the session. */
export function useSessionDrivesBrowser(sessionId: string | undefined): boolean {
  return useBrowserControlStore((s) =>
    sessionId ? Object.values(s.tabSessions).includes(sessionId) : false
  )
}

export function useSessionBrowserStopped(sessionId: string | undefined): boolean {
  return useBrowserControlStore((s) => (sessionId ? Boolean(s.stoppedSessions[sessionId]) : false))
}

/** The session driving an agent browser tab, if any. */
export function useAgentTabSession(tabId: string | undefined): string | undefined {
  return useBrowserControlStore((s) => (tabId ? s.tabSessions[tabId] : undefined))
}
