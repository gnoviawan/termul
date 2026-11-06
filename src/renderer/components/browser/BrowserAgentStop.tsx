/**
 * The agent-control indicator with Stop, shown whenever an agent drives a
 * browser tab for a session: as a bar in the session's chat and as a
 * button on the agent's browser tab. Stop ends the agent's browsing at
 * once and keeps it refused until the user's next message; the host owns
 * the latch, so desktop and remote clients show the same state.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Globe, Square } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { stopBrowserAgent } from '@/lib/browser-consent-api'
import { logFrontendError } from '@/lib/log-api'
import { useSessionBrowserStopped, useSessionDrivesBrowser } from '@/stores/browser-control-store'

export const BROWSER_STOP_LABEL = 'Stop agent browsing'

function useStop(sessionId: string): { stop: () => void; pending: boolean } {
  const [pending, setPending] = useState(false)
  const stop = (): void => {
    if (pending) return
    setPending(true)
    void stopBrowserAgent(sessionId)
      .then((ok) => {
        if (ok) return
        toast.error('Could not stop the agent browser. Try again.')
        void logFrontendError({
          level: 'warn',
          message: `browser stop failed: sessionId=${sessionId}`,
          source: 'BrowserAgentStop'
        })
      })
      .finally(() => setPending(false))
  }
  return { stop, pending }
}

/** Chat-side bar: renders only while the session drives a browser tab. */
export function BrowserAgentIndicator({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const drives = useSessionDrivesBrowser(sessionId)
  const stopped = useSessionBrowserStopped(sessionId)
  const { stop, pending } = useStop(sessionId)
  if (!drives) return null
  return (
    <div
      role="status"
      data-testid="browser-agent-indicator"
      className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5 text-xs"
    >
      <Globe size={13} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {stopped ? 'Browsing stopped until your next message.' : 'The agent is using the browser.'}
      </span>
      {stopped ? null : (
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={pending}
          onClick={stop}
          aria-label={BROWSER_STOP_LABEL}
        >
          <Square size={12} aria-hidden="true" />
          Stop
        </Button>
      )}
    </div>
  )
}

/** Tab-side Stop button for an agent browser tab. */
export function BrowserAgentTabStop({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const stopped = useSessionBrowserStopped(sessionId)
  const { stop, pending } = useStop(sessionId)
  if (stopped) return null
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      disabled={pending}
      aria-label={BROWSER_STOP_LABEL}
      title={BROWSER_STOP_LABEL}
      data-testid="browser-agent-tab-stop"
      onClick={(event) => {
        event.stopPropagation()
        stop()
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="size-4 shrink-0 text-destructive hover:text-destructive"
    >
      <Square size={10} aria-hidden="true" />
    </Button>
  )
}
