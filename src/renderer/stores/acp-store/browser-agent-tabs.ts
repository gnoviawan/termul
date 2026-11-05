/**
 * Host-mediated agent browser tab lifecycle on the session stream
 * (spec-acp-browser-pane-automation): `acp:browser_agent_tab` and
 * `acp:browser_tab_closed`.
 */

import type { BrowserAgentTabEvent, BrowserTabClosedEvent } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useBrowserControlStore } from '@/stores/browser-control-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useWorkspaceStore, browserTabId as workspaceBrowserTabId } from '@/stores/workspace-store'
import { isHistoryCoveredToolEvent } from './shared-state'

const SOURCE = 'acp-store:_onBrowserAgentTab'

/**
 * "open": create the session record + mount a workspace tab — mounting runs
 * `browserTabCreate`, which resolves the host's pending open waiter.
 * "close": drop the workspace tab + session record (the host already
 * destroyed the native webview; the unmount's destroy is a benign miss).
 * Remote/web clients have no native browser pane: there the event only feeds
 * the Stop indicator; only the desktop host opens the tab.
 *
 * Issue #1606: an "open" the installed history already covers is a replay of
 * the durable log. The tab belonged to a browser-automation session that no
 * longer exists (the host owns agent tabs for its lifetime only), so it must
 * not come back as an orphan nothing can list, drive or close. The live-turn
 * attach still applies its in-turn replay: that host turn is running.
 */
export function applyBrowserAgentTab(e: BrowserAgentTabEvent, eventSeq?: number): void {
  if (typeof e.tabId !== 'string' || e.tabId.length === 0) return
  if (e.action === 'open' && isHistoryCoveredToolEvent(e.sessionId, eventSeq)) {
    void logFrontendError({
      level: 'info',
      message: `[acp] replayed agent browser tab open skipped (tabId=${e.tabId}, seq=${eventSeq})`,
      source: SOURCE
    })
    return
  }
  const control = useBrowserControlStore.getState()
  if (e.action === 'open' && typeof e.sessionId === 'string' && e.sessionId.length > 0) {
    control.trackAgentTab(e.tabId, e.sessionId)
  } else if (e.action === 'close') {
    control.untrackAgentTab(e.tabId)
  }
  if (!isTauriContext()) return
  if (e.action === 'open') {
    const url = typeof e.url === 'string' && /^https?:\/\//i.test(e.url) ? e.url : undefined
    useBrowserSessionStore.getState().createTab(e.tabId, url)
    useWorkspaceStore.getState().openAgentBrowserTab(e.tabId, url)
    void logFrontendError({
      level: 'info',
      message: `[acp] agent browser tab opened (tabId=${e.tabId})`,
      source: SOURCE
    })
    return
  }
  if (e.action === 'close') dropAgentTab(e.tabId)
}

/**
 * The host registry dropped an agent tab (the user closed it, its webview
 * went away). Without this, its Stop ownership outlived the tab, and a
 * replayed log kept the tab's earlier "open" with nothing to cancel it.
 */
export function applyBrowserTabClosed(e: BrowserTabClosedEvent): void {
  if (typeof e.tabId !== 'string' || e.tabId.length === 0) return
  useBrowserControlStore.getState().untrackAgentTab(e.tabId)
  if (!isTauriContext()) return
  dropAgentTab(e.tabId)
}

function dropAgentTab(tabId: string): void {
  useWorkspaceStore.getState().removeTab(workspaceBrowserTabId(tabId))
  useBrowserSessionStore.getState().removeTab(tabId)
}
