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
 * Security: the strip lives in the main webview's DOM, so page-injected UI
 * never carries the decision (page JS could self-click), and the host's
 * `browser_ticket_respond` command rejects non-`main` callers. The answer
 * buttons arm a moment after the prompt appears (the host refuses faster
 * answers too).
 */

import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  browserConsentFileLine,
  browserConsentOptionLabel,
  browserConsentProfileLabel,
  browserConsentSummary,
  browserConsentTargetLine,
  browserConsentTitle,
  useConsentArmed
} from '@/components/browser/consent-intent'
import { ShieldAlert } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useAgentDisplayName } from '@/hooks/use-agent-display-name'
import { useInterfaceOverlayOpen } from '@/hooks/use-native-webview-occlusion'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useConsentStripHost } from '@/stores/browser-consent-strip-store'
import { useAgentTabSession } from '@/stores/browser-control-store'
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
  const overlayOpen = useInterfaceOverlayOpen()
  const register = useConsentStripHost((s) => s.register)
  const unregister = useConsentStripHost((s) => s.unregister)
  const loggedRequestRef = useRef<string | null>(null)

  // Mounted == a live host for this pane's prompt — registered even while no
  // consent is pending so the card fallbacks can suppress accurately.
  useEffect(() => {
    register(browserTabId)
    return () => unregister(browserTabId)
  }, [browserTabId, register, unregister])

  // Prefer the ticket of the session that drives this tab.
  const owner = useAgentTabSession(browserTabId)
  const tickets = Object.values(pending ?? {})
  const first = tickets.find((t) => t.sessionId === owner) ?? tickets[0]
  const firstAgentId = useAcpStore((s) =>
    first ? s.sessions[first.sessionId]?.agentId : undefined
  )
  const agentName = useAgentDisplayName(firstAgentId)
  const armed = useConsentArmed(first?.requestId ?? '')
  const hosting =
    isTauriContext() &&
    !overlayOpen &&
    activeTab?.type === 'browser' &&
    activeTab.browserTabId === browserTabId

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
  // in-chat card (and the root fallback host when no chat panel can show it)
  // presents the ticket. Other visible browser panes in a split never
  // duplicate it. Double-click guard lives in the store: answering drops the
  // pending entry (unmounting these buttons) and a refused answer restores it.
  if (!hosting || !first) return null

  return (
    <AlertOnceStripFrame
      key={first.requestId}
      requestId={first.requestId}
      title={browserConsentTitle(first.action)}
    >
      <ShieldAlert size={14} className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-2xs">
        <span className="font-medium text-foreground">{browserConsentTitle(first.action)}</span>{' '}
        <span className="break-words text-muted-foreground">
          {browserConsentSummary(agentName, first)}
        </span>
        <span className="block truncate font-mono text-muted-foreground" title={first.targetUrl}>
          {browserConsentTargetLine(first)}
        </span>
        {first.file ? (
          <span className="block truncate text-foreground">
            File: {browserConsentFileLine(first.file)}
          </span>
        ) : null}
        <span className="block truncate text-muted-foreground">
          {first.element ? `Agent says: "${first.element}" · ` : ''}
          {browserConsentProfileLabel(first.profile)}
        </span>
      </div>
      {first.options.map((optionId) => (
        <Button
          key={optionId}
          type="button"
          size="xs"
          variant={
            optionId === 'deny' ? 'ghost' : optionId === 'allow_session' ? 'default' : 'outline'
          }
          disabled={!armed}
          onClick={() => respond(first.requestId, optionId)}
          className="shrink-0 text-2xs"
        >
          {browserConsentOptionLabel(optionId, first.action)}
        </Button>
      ))}
    </AlertOnceStripFrame>
  )
}

function AlertOnceStripFrame({
  requestId,
  title,
  children
}: {
  requestId: string
  title: string
  children: ReactNode
}): React.JSX.Element {
  const [isFirstMountForRequest] = useState(
    () => !useConsentStripHost.getState().announcedRequestIds.has(requestId)
  )
  const markAnnounced = useConsentStripHost((s) => s.markAnnounced)
  useEffect(() => markAnnounced(requestId), [requestId, markAnnounced])

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-l-2 border-warning border-b border-border bg-card px-3 py-1.5"
      {...(isFirstMountForRequest ? { role: 'alert' } : { role: 'region', 'aria-label': title })}
    >
      {children}
    </div>
  )
}
