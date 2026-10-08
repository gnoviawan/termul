import type { ReactNode } from 'react'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
import { STATUS_BAR_HIT_GLYPH, STATUS_BAR_HIT_TARGET } from '@/components/status-bar-hit'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  type ConnectionChannelState,
  useConnectionStatusStore
} from '@/stores/connection-status-store'

/** Rollup severity — higher wins when the two channels disagree. */
const SEVERITY: Record<ConnectionChannelState, number> = {
  connected: 0,
  connecting: 1,
  reconnecting: 2,
  disconnected: 3
}

interface ConnectionStatusIndicatorProps {
  /**
   * `chrome` (default) is the StatusBar's `primary-foreground` ink. `status`
   * uses the connection / warning / destructive lamp colours on card surfaces.
   */
  tone?: 'chrome' | 'status'
  /**
   * Render the summary as visible text beside a decorative lamp (the mobile
   * drawer footer, where the tooltip is unreachable by touch). The status
   * region's content is that text, so there is no `aria-label` and no tooltip
   * button. Default false keeps the StatusBar render unchanged.
   */
  showLabel?: boolean
}

/**
 * Story 10 (F1): global connection-health indicator for the web client — a
 * StatusBar lamp showing the worst of the control (`/ws`) and terminal
 * (`/terminal/ws`) channels. Chrome ink (`primary-foreground`); shape and
 * pulse encode state. Hidden on Tauri desktop: both
 * channels are direct IPC there, so an indicator would be noise.
 */
export function ConnectionStatusIndicator({
  tone = 'chrome',
  showLabel = false
}: ConnectionStatusIndicatorProps): ReactNode {
  const controlChannel = useConnectionStatusStore((state) => state.controlChannel)
  const terminalChannel = useConnectionStatusStore((state) => state.terminalChannel)

  // Desktop: no WS channels — render nothing. (Hook order is safe: both
  // subscriptions run before this early return.)
  if (isTauriContext()) return null

  const worst =
    SEVERITY[controlChannel] >= SEVERITY[terminalChannel] ? controlChannel : terminalChannel
  const degraded: string[] = []
  if (controlChannel !== 'connected') degraded.push(`Control channel: ${controlChannel}`)
  if (terminalChannel !== 'connected') degraded.push(`Terminal channel: ${terminalChannel}`)
  const summary = degraded.length > 0 ? degraded.join('; ') : 'Connected'

  if (showLabel) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex min-w-0 items-center gap-2 text-2xs text-muted-foreground"
      >
        <AgentConnectionLamp
          connected={worst === 'connected'}
          reconnecting={worst === 'connecting' || worst === 'reconnecting'}
          decorative
          size={8}
          tone={tone}
        />
        <span className="min-w-0">{summary}</span>
      </span>
    )
  }

  return (
    // role="status" announces state changes politely; the inner button is the
    // keyboard-focusable tooltip trigger (natively focusable — no tabIndex),
    // so the degraded-channel summary is reachable without a mouse. The
    // trigger keeps an 8px lamp: desktop pads a 20px slot with ::after, and
    // coarse pointers use a 44px border box that does not grow the 24px bar
    // (#881, see status-bar-hit).
    <span
      role="status"
      aria-live="polite"
      aria-label={summary}
      className="inline-flex shrink-0 items-center"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={summary} className={STATUS_BAR_HIT_TARGET}>
            <span className={STATUS_BAR_HIT_GLYPH}>
              <AgentConnectionLamp
                connected={worst === 'connected'}
                reconnecting={worst === 'connecting' || worst === 'reconnecting'}
                decorative
                size={8}
                tone={tone}
              />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{summary}</TooltipContent>
      </Tooltip>
    </span>
  )
}
