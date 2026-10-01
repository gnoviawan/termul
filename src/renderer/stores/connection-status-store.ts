/**
 * Story 10 (F1/F9/F10/F11): global connection-health store — the single
 * source of truth for the two web WS channels:
 *
 * - `controlChannel`: the multiplexed ACP `/ws` channel (fed by
 *   `WsAcpTransport.setConnectionStateListener`).
 * - `terminalChannel`: the `/terminal/ws` channel (fed by
 *   `WebTerminalClient.setConnectionStateListener`).
 *
 * Consumers: the StatusBar `ConnectionStatusIndicator` (worst-of rollup),
 * `ConnectedTerminal` (per-terminal reconnect overlay), and `FileExplorer`
 * (root-load retry on control-channel recovery).
 *
 * Web-only: `wireConnectionStatusTracking()` is a no-op on Tauri desktop
 * (both transports there are direct IPC), so the channels stay at their
 * initial values and every consumer renders its healthy/no-op state.
 */

import { create } from 'zustand'
import { type AcpConnectionState, getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  getWebTerminalConnectionState,
  setWebTerminalConnectionStateListener
} from '@/lib/web-terminal-api'

export type ConnectionChannelState = AcpConnectionState

interface ConnectionStatusState {
  controlChannel: ConnectionChannelState
  terminalChannel: ConnectionChannelState
  setControlChannel: (state: ConnectionChannelState) => void
  setTerminalChannel: (state: ConnectionChannelState) => void
}

export const useConnectionStatusStore = create<ConnectionStatusState>((set) => ({
  // The control channel starts 'connecting' — the web client always opens
  // `/ws` at boot, so showing anything else would be a lie. The terminal
  // channel starts 'connected': it connects lazily on first use, so idle
  // (no terminal ever spawned) is healthy, not degraded.
  controlChannel: 'connecting',
  terminalChannel: 'connected',
  setControlChannel: (controlChannel) =>
    set((prev) => {
      logChannelTransition('control', prev.controlChannel, controlChannel)
      return { controlChannel }
    }),
  setTerminalChannel: (terminalChannel) =>
    set((prev) => {
      logChannelTransition('terminal', prev.terminalChannel, terminalChannel)
      return { terminalChannel }
    })
}))
/**
 * Durable boundary log for each channel state transition. `disconnected` is
 * a failure (the channel gave up); every other transition is a boundary
 * event at warn. Metadata only — channel name + state, never payloads,
 * tokens, or credentials. Change-gated so a repeated identical state (e.g.
 * the wiring replay landing on the current value) does not log noise.
 */
function logChannelTransition(
  channel: 'control' | 'terminal',
  prev: ConnectionChannelState,
  next: ConnectionChannelState
): void {
  if (prev === next) return
  void logFrontendError({
    level: next === 'disconnected' ? 'error' : 'warn',
    source: 'connection-status-store',
    message: `${channel} channel state: ${prev} → ${next}`
  })
}

let wired = false

/**
 * Web-only: subscribe both channel health feeds to the store. Idempotent.
 * No-op on Tauri desktop — no WS transports exist there (the indicator stays
 * hidden and terminal writes go direct over IPC).
 */
export function wireConnectionStatusTracking(): void {
  if (wired) return
  if (isTauriContext()) return
  wired = true
  const { setControlChannel, setTerminalChannel } = useConnectionStatusStore.getState()
  // Optional method: absent on transports that don't implement it (e.g. a
  // Tauri IPC transport in a test) — guard rather than assume.
  const acp = getAcpTransport()
  acp.setConnectionStateListener?.(setControlChannel)
  setWebTerminalConnectionStateListener(setTerminalChannel)
  // Replay each transport's CURRENT state so anything emitted before wiring
  // (e.g. a boot 'connected' that raced the listener registration) is
  // reflected in the store instead of leaving a stale initial value.
  const acpState = acp.getConnectionState?.()
  if (acpState) setControlChannel(acpState)
  setTerminalChannel(getWebTerminalConnectionState())
}

/** @internal test helper — re-arm wiring + restore initial channel state. */
export function _resetConnectionStatusWiringForTests(): void {
  wired = false
  useConnectionStatusStore.setState({
    controlChannel: 'connecting',
    terminalChannel: 'connected'
  })
}
