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

import { BrowserConsentCard } from '@/components/chat/BrowserConsentCard'
import {
  useInterfaceOverlayOpen,
  useNativeWebviewOcclusion
} from '@/hooks/use-native-webview-occlusion'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useConsentCardHost } from '@/stores/browser-consent-card-store'
import { useIsConsentStripHosting } from '@/stores/browser-consent-strip-store'

export function BrowserConsentCardHost(): React.JSX.Element | null {
  const pending = useAcpStore((s) => s.pendingBrowserConsents)
  const hosted = useConsentCardHost((s) => s.hostedSessionIds)
  const stripHosting = useIsConsentStripHosting()
  const overlayOpen = useInterfaceOverlayOpen()

  const unhosted =
    isTauriContext() && !stripHosting
      ? Object.values(pending ?? {}).filter((c) => overlayOpen || !hosted.has(c.sessionId))
      : []

  useNativeWebviewOcclusion(unhosted.length > 0, 'docked')

  if (unhosted.length === 0) return null

  return (
    <div
      className="pointer-events-auto fixed right-4 bottom-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      data-testid="browser-consent-card-host"
    >
      {unhosted.map((consent) => (
        <BrowserConsentCard key={consent.requestId} consent={consent} />
      ))}
    </div>
  )
}
