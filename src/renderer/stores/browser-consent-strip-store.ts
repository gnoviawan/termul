/**
 * Mount registry for the in-pane browser consent strip
 * (spec-acp-browser-pane-agent-ui).
 *
 * `BrowserConsentStrip` registers its panel's browserTabId on mount and
 * unregisters on unmount, so `useIsConsentStripHosting` is true only when a
 * strip is *actually rendered* for the focused pane's active browser tab —
 * keying on `useActiveTab()` alone leaves dead states (SSH workspace mode,
 * non-workspace routes like /snapshots) where a browser-type activeTab exists
 * in the store but no BrowserPanel is mounted, and neither the strip nor the
 * in-chat consent card would show.
 *
 * Single predicate shared by the strip, the in-chat `BrowserConsentCard`, and
 * the root `BrowserConsentCardHost` fallback — the three must agree forever.
 */

import { create } from 'zustand'
import { useActiveTab } from './workspace-store'

interface ConsentStripHostState {
  mountedBrowserTabIds: ReadonlySet<string>
  register: (browserTabId: string) => void
  unregister: (browserTabId: string) => void
}

export const useConsentStripHost = create<ConsentStripHostState>((set) => ({
  mountedBrowserTabIds: new Set<string>(),
  register: (browserTabId) =>
    set((s) => {
      const next = new Set(s.mountedBrowserTabIds)
      next.add(browserTabId)
      return { mountedBrowserTabIds: next }
    }),
  unregister: (browserTabId) =>
    set((s) => {
      const next = new Set(s.mountedBrowserTabIds)
      next.delete(browserTabId)
      return { mountedBrowserTabIds: next }
    })
}))

/**
 * True while a live consent strip exists for the focused pane's active
 * browser tab — i.e. the in-pane prompt is genuinely on screen and the
 * in-chat consent card must stay suppressed.
 */
export function useIsConsentStripHosting(): boolean {
  const activeTab = useActiveTab()
  const mounted = useConsentStripHost((s) => s.mountedBrowserTabIds)
  return activeTab?.type === 'browser' && mounted.has(activeTab.browserTabId)
}
