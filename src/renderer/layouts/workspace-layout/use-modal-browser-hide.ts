import { useEffect, useRef } from 'react'
import { browserTabHide, browserTabShow } from '@/lib/browser-api'
import type { WorkspaceTab } from '@/stores/workspace-store'

interface UseModalBrowserHideOptions {
  isNewProjectModalOpen: boolean
  isAgentLauncherOpen: boolean
  activeTab: WorkspaceTab | undefined
}

/** Hides the active browser webview while a modal/overlay is open. */
export function useModalBrowserHide({
  isNewProjectModalOpen,
  isAgentLauncherOpen,
  activeTab
}: UseModalBrowserHideOptions): void {
  const hiddenBrowserTabForModalRef = useRef<string | null>(null)

  useEffect(() => {
    // Hide the active browser webview while a modal/overlay is open, since native
    // child webviews paint above the DOM and would otherwise obscure it. Covers
    // the New Project modal and the agent launcher overlay. The browser consent
    // prompt no longer hides the pane: it renders as the in-pane
    // BrowserConsentStrip or the in-chat BrowserConsentCard, neither of which
    // overlays the webview (spec-acp-browser-automation-v2 CAP-5).
    const modalOpen = isNewProjectModalOpen || isAgentLauncherOpen
    if (modalOpen) {
      if (activeTab?.type === 'browser') {
        hiddenBrowserTabForModalRef.current = activeTab.browserTabId
        browserTabHide(activeTab.browserTabId).catch(console.error)
      }
      return
    }

    const hiddenBrowserTabId = hiddenBrowserTabForModalRef.current
    if (hiddenBrowserTabId) {
      browserTabShow(hiddenBrowserTabId).catch(console.error)
      hiddenBrowserTabForModalRef.current = null
    }
  }, [isNewProjectModalOpen, isAgentLauncherOpen, activeTab])
}
