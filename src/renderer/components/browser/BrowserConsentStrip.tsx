/**
 * In-pane agent browser-automation consent strip
 * (spec-acp-browser-pane-agent-ui).
 *
 * Renders inside the focused pane's active BrowserPanel between the pane
 * controls and the webview container — the panel's ResizeObserver shrinks
 * the native webview to make room, so the prompt docks in the pane instead
 * of hiding it behind a modal (native child webviews paint above DOM).
 * The in-chat `BrowserConsentCard` is the fallback surface whenever no live
 * strip hosts the focused browser tab (spec-acp-browser-automation-v2 CAP-5).
 *
 * Mount presence is tracked in `useConsentStripHost`: the strip/card split
 * must reflect what is actually on screen, not just the workspace store's
 * activeTab — on non-workspace routes or SSH mode a browser-type activeTab
 * persists with no BrowserPanel mounted.
 *
 * Security: the strip lives in the main webview's DOM — page-injected UI is
 * never allowed to carry the consent decision (page JS could self-click),
 * and `browser_consent_respond` rejects non-`main` callers.
 */

import { useEffect, useRef, useState } from 'react'
import { BROWSER_CONSENT_TITLE, browserConsentSummary } from '@/components/browser/consent-intent'
import { ShieldAlert } from '@/components/icons'
import { useAgentDisplayName } from '@/hooks/use-agent-display-name'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useConsentStripHost } from '@/stores/browser-consent-strip-store'
import { useActiveTab } from '@/stores/workspace-store'

interface BrowserConsentStripProps {
  browserTabId: string
}

export function BrowserConsentStrip({
  browserTabId
}: BrowserConsentStripProps): React.JSX.Element | null {
  const pending = useAcpStore((s) => s.pendingBrowserConsents)
  const respond = useAcpStore((s) => s.respondBrowserConsent)
  const activeTab = useActiveTab()
  const register = useConsentStripHost((s) => s.register)
  const unregister = useConsentStripHost((s) => s.unregister)
  const [respondedId, setRespondedId] = useState<string | null>(null)
  const loggedRequestRef = useRef<string | null>(null)

  // Mounted == a live host for this pane's prompt — registered even while no
  // consent is pending so the card fallbacks can suppress accurately.
  useEffect(() => {
    register(browserTabId)
    return () => unregister(browserTabId)
  }, [browserTabId, register, unregister])

  const first = Object.values(pending ?? {})[0]
  const agentName = useAgentDisplayName(first?.agentId)
  const hosting =
    isTauriContext() && activeTab?.type === 'browser' && activeTab.browserTabId === browserTabId

  // Boundary log (durable): once per request, record that the in-pane strip
  // owns this consent decision rather than the in-chat card fallbacks.
  useEffect(() => {
    if (!hosting || !first || loggedRequestRef.current === first.requestId) return
    loggedRequestRef.current = first.requestId
    void logFrontendError({
      level: 'info',
      message: `browser consent strip hosting prompt: requestId=${first.requestId}`,
      source: 'BrowserConsentStrip'
    })
  }, [hosting, first])

  // Single host: the strip renders only while this pane is focused AND its
  // active tab is this agent browser tab (the `hosting` condition above).
  // The agent tab open deliberately keeps the chat pane focused
  // (openAgentBrowserTab), so until the user focuses the browser pane the
  // prompt is not hosted here — consent presentation for non-browser focus
  // is handled by the in-chat card (and the root fallback host when no chat
  // panel can show it). Other visible browser panes in a split never
  // duplicate it. Phase-1 consent is granted by the desktop host only —
  // remote clients never see a prompt; the host auto-denies on timeout.
  if (!hosting || !first) return null

  // One response per request — a deny re-prompt produces a NEW requestId, so
  // the guard keys on the id rather than a once-ever flag.
  const responded = respondedId === first.requestId

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-l-2 border-warning border-b border-border bg-card px-3 py-1.5"
      role="alert"
    >
      <ShieldAlert size={14} className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-2xs">
        <span className="font-medium text-foreground">{BROWSER_CONSENT_TITLE}</span>{' '}
        <span className="line-clamp-2 break-words text-muted-foreground">
          {browserConsentSummary(agentName, first.action, first.element)}
        </span>
      </div>
      <button
        type="button"
        disabled={responded}
        onClick={() => {
          setRespondedId(first.requestId)
          respond(first.requestId, false)
        }}
        className="shrink-0 rounded px-2.5 py-1 text-2xs font-medium text-muted-foreground ring-offset-background transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      >
        Deny
      </button>
      <button
        type="button"
        disabled={responded}
        onClick={() => {
          setRespondedId(first.requestId)
          respond(first.requestId, true)
        }}
        className="shrink-0 rounded bg-destructive-fill px-2.5 py-1 text-2xs font-medium text-destructive-foreground ring-offset-background transition-colors hover:bg-destructive-fill/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      >
        Allow for this session
      </button>
    </div>
  )
}
