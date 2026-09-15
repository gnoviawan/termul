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
import { isTauriContext } from '@/lib/tauri-runtime'
import { setWebTerminalConnectionStateListener } from '@/lib/web-terminal-api'

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
  setControlChannel: (controlChannel) => set({ controlChannel }),
  setTerminalChannel: (terminalChannel) => set({ terminalChannel })
}))

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
  getAcpTransport().setConnectionStateListener?.(setControlChannel)
  setWebTerminalConnectionStateListener(setTerminalChannel)
}

/** @internal test helper — re-arm wiring + restore initial channel state. */
export function _resetConnectionStatusWiringForTests(): void {
  wired = false
  useConnectionStatusStore.setState({
    controlChannel: 'connecting',
    terminalChannel: 'connected'
  })
}
