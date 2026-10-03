/**
 * In-chat agent browser-automation consent card
 * (spec-acp-browser-automation-v2 CAP-5).
 *
 * Fallback surface for the once-per-session browser consent when the user's
 * focus is anywhere but the agent browser tab: the focused pane's
 * `BrowserConsentStrip` owns the prompt while a live strip is mounted for the
 * active browser tab, and this card renders in the session's chat panel
 * otherwise (chat, terminal, or any other focus). Panes never overlap, so the
 * card cannot paint over the native browser webview — no modal, no
 * webview-hide workaround. `BrowserConsentCardHost` reuses this card as the
 * root-level fallback for states where no chat panel can show it.
 *
 * Modeled on `PermissionPrompt`: inline card, `Button` variants, semantic
 * tokens, `aria-live`, and deliberately no dismiss or outside-click behavior —
 * the host auto-denies on timeout, and the agent stays blocked until the user
 * picks Allow or Deny. A failed respond restores the pending entry (the store
 * optimistically deletes it and puts it back on invoke failure), and the card
 * remounts enabled — no local one-response flag, which would block the retry.
 *
 * Security: the card lives in the main webview's DOM — page-injected UI is
 * never allowed to carry the consent decision, and `browser_consent_respond`
 * rejects non-`main` callers.
 */

import { useEffect, useRef } from 'react'
import {
  BROWSER_CONSENT_TITLE,
  browserConsentSummary,
  browserConsentTitleId
} from '@/components/browser/consent-intent'
import { ShieldAlert, ShieldCheck } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useAgentDisplayName } from '@/hooks/use-agent-display-name'
import type { BrowserConsentRequestEvent } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useIsConsentStripHosting } from '@/stores/browser-consent-strip-store'

interface BrowserConsentCardProps {
  /** The pending consent belonging to this panel's session. */
  consent: BrowserConsentRequestEvent
}

export function BrowserConsentCard({ consent }: BrowserConsentCardProps): React.JSX.Element | null {
  const respond = useAcpStore((s) => s.respondBrowserConsent)
  const agentName = useAgentDisplayName(consent.agentId)
  const stripHosting = useIsConsentStripHosting()
  const loggedRequestRef = useRef<string | null>(null)

  // The card is the fallback surface: it renders only while no live strip
  // hosts the focused pane's active browser tab (mutual exclusion, CAP-5).
  // Phase-1 consent is granted on the desktop host only — remote clients
  // (WS relay) never see a prompt; the host auto-denies on timeout.
  const hosting = isTauriContext() && !stripHosting

  // Boundary log (durable): once per request, record that the in-chat card
  // owns this consent decision rather than the in-pane strip.
  useEffect(() => {
    if (!hosting || loggedRequestRef.current === consent.requestId) return
    loggedRequestRef.current = consent.requestId
    void logFrontendError({
      level: 'info',
      message: `browser consent card hosting prompt: requestId=${consent.requestId}`,
      source: 'BrowserConsentCard'
    })
  }, [hosting, consent.requestId])

  if (!hosting) return null

  const titleId = browserConsentTitleId(consent.requestId)
  const choose = (allowed: boolean): void => {
    respond(consent.requestId, allowed)
  }

  return (
    <section
      aria-labelledby={titleId}
      aria-live="polite"
      className="rounded-2xl border border-warning/25 bg-card px-3.5 py-3 shadow-sm sm:px-4"
      data-testid="browser-consent-card"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning/15 text-warning">
          <ShieldAlert size={13} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-xs font-semibold leading-5 text-foreground">
            {BROWSER_CONSENT_TITLE}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {browserConsentSummary(agentName, consent.action, consent.element)} You'll watch it work
            in a visible tab; closing the tab stops it.
          </p>
        </div>
      </div>

      <fieldset className="mt-2.5 flex flex-wrap items-center gap-2">
        <legend className="sr-only">Browser consent options</legend>
        <Button
          variant="default"
          size="sm"
          onClick={() => choose(true)}
          className="h-8 min-w-0 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-[transform,color,background-color,border-color] duration-150 active:scale-[0.96]"
        >
          <ShieldCheck size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Allow for this session</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => choose(false)}
          className="h-8 min-w-0 rounded-lg border-transparent px-3 text-xs font-medium text-muted-foreground whitespace-nowrap transition-[transform,color,background-color,border-color] duration-150 hover:border-destructive/25 hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]"
        >
          <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Deny</span>
        </Button>
      </fieldset>
    </section>
  )
}
