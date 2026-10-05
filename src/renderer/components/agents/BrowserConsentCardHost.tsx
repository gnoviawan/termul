/**
 * Root-level fallback host for the in-chat browser consent card
 * (spec-acp-browser-automation-v2 CAP-5).
 *
 * The centered `ConfirmDialog` modal is gone; the consent surfaces are the
 * in-pane `BrowserConsentStrip` (browser pane focused, agent tab active) and
 * the in-chat `BrowserConsentCard` (any other focus). But the in-chat card
 * only exists while a chat panel is mounted AND its tab is the pane's active
 * tab — on non-workspace routes, in SSH mode, for warm-pool sessions without
 * a chat tab, or while the chat tab is hidden behind another tab, a pending
 * consent would otherwise be unanswerable and silently auto-deny on the host
 * timeout. This host renders corner-docked cards (NOT a modal, no overlay
 * scrim) for exactly those pending consents, mirroring the strip's
 * mount-registry pattern: `AgentChatPanel` registers visible cards in
 * `useConsentCardHost`, so the host renders only unhosted consents, and it
 * stays empty while the strip is hosting.
 *
 * Desktop-only like every consent surface — remote clients never see a
 * prompt; the host auto-denies on timeout.
 */

import { useEffect, useRef } from 'react'
import { BrowserConsentCard } from '@/components/chat/BrowserConsentCard'
import { browserTabHide, browserTabShow } from '@/lib/browser-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useConsentCardHost } from '@/stores/browser-consent-card-store'
import { useIsConsentStripHosting } from '@/stores/browser-consent-strip-store'
import { useActiveTab } from '@/stores/workspace-store'

export function BrowserConsentCardHost(): React.JSX.Element | null {
  const pending = useAcpStore((s) => s.pendingBrowserConsents)
  const hosted = useConsentCardHost((s) => s.hostedSessionIds)
  const stripHosting = useIsConsentStripHosting()
  const activeTab = useActiveTab()
  const hiddenBrowserTabRef = useRef<string | null>(null)

  const unhosted =
    isTauriContext() && !stripHosting
      ? Object.values(pending ?? {}).filter((c) => !hosted.has(c.sessionId))
      : []

  // Native child webviews paint above DOM — while a fallback card is on
  // screen and the focused pane's active tab is a browser tab, hide that
  // webview so the card stays clickable (the same workaround the removed
  // consent modal used, scoped to the root-fallback case only).
  useEffect(() => {
    if (unhosted.length > 0 && activeTab?.type === 'browser') {
      hiddenBrowserTabRef.current = activeTab.browserTabId
      browserTabHide(activeTab.browserTabId).catch(console.error)
      return
    }
    const hiddenBrowserTabId = hiddenBrowserTabRef.current
    if (hiddenBrowserTabId) {
      browserTabShow(hiddenBrowserTabId).catch(console.error)
      hiddenBrowserTabRef.current = null
    }
  }, [unhosted.length, activeTab])

  if (unhosted.length === 0) return null

  return (
    <div
      className="fixed right-4 bottom-4 z-40 flex w-full max-w-sm flex-col gap-2"
      data-testid="browser-consent-card-host"
    >
      {unhosted.map((consent) => (
        <BrowserConsentCard key={consent.requestId} consent={consent} />
      ))}
    </div>
  )
}
