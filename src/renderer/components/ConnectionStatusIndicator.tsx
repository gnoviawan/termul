import type { ReactNode } from 'react'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
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
/**
 * Story 10 (F1): global connection-health indicator for the web client — a
 * StatusBar lamp showing the worst of the control (`/ws`) and terminal
 * (`/terminal/ws`) channels, reusing the `AgentConnectionLamp` idiom (green =
 * connected, amber pulse = connecting/reconnecting, red = disconnected). The
 * tooltip names the degraded channel(s). Hidden on Tauri desktop: both
 * channels are direct IPC there, so an indicator would be noise.
 */
export function ConnectionStatusIndicator(): ReactNode {
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

  return (
    // role="status" announces state changes politely; the inner button is the
    // keyboard-focusable tooltip trigger (natively focusable — no tabIndex),
    // so the degraded-channel summary is reachable without a mouse.
    <span role="status" aria-live="polite" aria-label={summary} className="inline-flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={summary} className="flex items-center px-1 py-0.5">
            <AgentConnectionLamp
              connected={worst === 'connected'}
              reconnecting={worst === 'connecting' || worst === 'reconnecting'}
              decorative
              size={8}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{summary}</TooltipContent>
      </Tooltip>
    </span>
  )
}
