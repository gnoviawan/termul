/**
 * In-chat agent browser consent card.
 *
 * Fallback surface for a browser consent ticket when the user's focus is
 * anywhere but the agent browser tab: the focused pane's
 * `BrowserConsentStrip` owns the prompt while a live strip is mounted for the
 * active browser tab, and this card renders in the session's chat panel
 * otherwise (chat, terminal, any other focus, and every remote client, which
 * has no browser pane). Panes never overlap, so the card cannot paint over
 * the native browser webview. `BrowserConsentCardHost` reuses this card as
 * the root-level fallback for states where no chat panel can show it.
 *
 * Modeled on `PermissionPrompt`: inline card, `Button` variants, semantic
 * tokens, `aria-live`, and deliberately no dismiss or outside-click behavior.
 * A refused answer restores the pending entry (the store optimistically
 * deletes it), and the card remounts enabled.
 *
 * Security: only host-supplied ticket fields are shown, never page title or
 * text, and the agent's stated intent is labelled as the agent's. The answer
 * buttons arm a moment after the card appears; the host refuses faster
 * answers too.
 */

import { useEffect, useRef } from 'react'
import {
  browserConsentFileLine,
  browserConsentOptionLabel,
  browserConsentProfileLabel,
  browserConsentSummary,
  browserConsentTargetLine,
  browserConsentTitle,
  browserConsentTitleId,
  useConsentArmed
} from '@/components/browser/consent-intent'
import { ShieldAlert, ShieldCheck } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useAgentDisplayName } from '@/hooks/use-agent-display-name'
import type { BrowserConsentTicket } from '@/lib/browser-consent-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useIsConsentStripHosting } from '@/stores/browser-consent-strip-store'

interface BrowserConsentCardProps {
  /** The pending ticket belonging to this panel's session. */
  consent: BrowserConsentTicket
}

export function BrowserConsentCard({ consent }: BrowserConsentCardProps): React.JSX.Element | null {
  const respond = useAcpStore((s) => s.respondBrowserConsent)
  const agentId = useAcpStore((s) => s.sessions[consent.sessionId]?.agentId)
  const agentName = useAgentDisplayName(agentId)
  const stripHosting = useIsConsentStripHosting()
  const armed = useConsentArmed(consent.requestId)
  const loggedRequestRef = useRef<string | null>(null)

  // The card is the fallback surface: it renders only while no live strip
  // hosts the focused pane's active browser tab (mutual exclusion).
  const hosting = !stripHosting

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
            {browserConsentTitle(consent.action)}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {browserConsentSummary(agentName, consent)} You'll watch it work in a visible tab.
          </p>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-2xs leading-relaxed">
            <dt className="text-muted-foreground">Site</dt>
            <dd className="truncate font-medium text-foreground">{consent.origin}</dd>
            <dt className="text-muted-foreground">Address</dt>
            <dd className="break-all font-mono text-muted-foreground">
              {browserConsentTargetLine(consent)}
            </dd>
            {consent.file ? (
              <>
                <dt className="text-muted-foreground">File</dt>
                <dd className="break-words font-medium text-foreground">
                  {browserConsentFileLine(consent.file)}
                </dd>
              </>
            ) : null}
            {consent.element ? (
              <>
                <dt className="text-muted-foreground">Agent says</dt>
                <dd className="break-words text-muted-foreground">"{consent.element}"</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Profile</dt>
            <dd className="text-muted-foreground">{browserConsentProfileLabel(consent.profile)}</dd>
          </dl>
        </div>
      </div>

      <fieldset className="mt-2.5 flex flex-wrap items-center gap-2">
        <legend className="sr-only">Browser consent options</legend>
        {consent.options.map((optionId) => (
          <Button
            key={optionId}
            variant={optionId === 'allow_session' ? 'default' : 'outline'}
            size="sm"
            disabled={!armed}
            onClick={() => respond(consent.requestId, optionId)}
            className={
              optionId === 'deny'
                ? 'h-8 min-w-0 rounded-lg border-transparent px-3 text-xs font-medium text-muted-foreground whitespace-nowrap transition-[transform,color,background-color,border-color] duration-150 hover:border-destructive/25 hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]'
                : 'h-8 min-w-0 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-[transform,color,background-color,border-color] duration-150 active:scale-[0.96]'
            }
          >
            {optionId === 'deny' ? (
              <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} className="shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{browserConsentOptionLabel(optionId, consent.action)}</span>
          </Button>
        ))}
      </fieldset>
    </section>
  )
}
