import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Story 10: connection-status store — web-only wiring of the two WS channel
 * health feeds (control `/ws` via the ACP transport, terminal `/terminal/ws`
 * via the web terminal client) into one store.
 */

const mocks = vi.hoisted(() => ({
  isTauriContext: vi.fn(() => false),
  acpListener: vi.fn(),
  terminalListener: vi.fn(),
  acpGetConnectionState: vi.fn(),
  terminalGetConnectionState: vi.fn(() => 'connected'),
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mocks.isTauriContext }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))
vi.mock('@/lib/acp-transport', () => ({
  getAcpTransport: () => ({
    setConnectionStateListener: mocks.acpListener,
    getConnectionState: mocks.acpGetConnectionState
  })
}))
vi.mock('@/lib/web-terminal-api', () => ({
  setWebTerminalConnectionStateListener: (listener: unknown) => mocks.terminalListener(listener),
  getWebTerminalConnectionState: mocks.terminalGetConnectionState
}))

import {
  _resetConnectionStatusWiringForTests,
  useConnectionStatusStore,
  wireConnectionStatusTracking
} from './connection-status-store'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isTauriContext.mockReturnValue(false)
  mocks.acpGetConnectionState.mockReturnValue(undefined)
  mocks.terminalGetConnectionState.mockReturnValue('connected')
  _resetConnectionStatusWiringForTests()
})

describe('connection-status-store', () => {
  it('starts with the control channel connecting and the terminal channel healthy', () => {
    // The control channel connects eagerly at boot; the terminal channel
    // connects lazily on first use (idle = nothing wrong).
    expect(useConnectionStatusStore.getState().controlChannel).toBe('connecting')
    expect(useConnectionStatusStore.getState().terminalChannel).toBe('connected')
  })

  it('updates channel state through the setters', () => {
    useConnectionStatusStore.getState().setControlChannel('reconnecting')
    useConnectionStatusStore.getState().setTerminalChannel('disconnected')
    expect(useConnectionStatusStore.getState().controlChannel).toBe('reconnecting')
    expect(useConnectionStatusStore.getState().terminalChannel).toBe('disconnected')
  })

  describe('wireConnectionStatusTracking (web)', () => {
    it('registers one listener per channel and routes events into the store', () => {
      wireConnectionStatusTracking()

      expect(mocks.acpListener).toHaveBeenCalledTimes(1)
      expect(mocks.terminalListener).toHaveBeenCalledTimes(1)

      const controlListener = mocks.acpListener.mock.calls[0][0] as (s: string) => void
      const terminalListener = mocks.terminalListener.mock.calls[0][0] as (s: string) => void

      controlListener('connected')
      expect(useConnectionStatusStore.getState().controlChannel).toBe('connected')
      // Channels are independent — the terminal channel is untouched.
      expect(useConnectionStatusStore.getState().terminalChannel).toBe('connected')

      terminalListener('reconnecting')
      expect(useConnectionStatusStore.getState().terminalChannel).toBe('reconnecting')
      expect(useConnectionStatusStore.getState().controlChannel).toBe('connected')
    })

    it('is idempotent — a second call does not re-register listeners', () => {
      wireConnectionStatusTracking()
      wireConnectionStatusTracking()
      expect(mocks.acpListener).toHaveBeenCalledTimes(1)
      expect(mocks.terminalListener).toHaveBeenCalledTimes(1)
    })

    it('replays each transport’s current state so pre-wiring emissions are reflected', () => {
      // The ACP socket finished its auth handshake BEFORE wiring ran — the
      // listener never saw 'connected', so without a replay the store would
      // be stuck at the initial 'connecting'.
      mocks.acpGetConnectionState.mockReturnValue('connected')
      mocks.terminalGetConnectionState.mockReturnValue('reconnecting')

      wireConnectionStatusTracking()

      expect(useConnectionStatusStore.getState().controlChannel).toBe('connected')
      expect(useConnectionStatusStore.getState().terminalChannel).toBe('reconnecting')
    })
  })

  describe('channel transition logging', () => {
    it('logs each state transition; disconnected is a failure (error level)', () => {
      useConnectionStatusStore.getState().setControlChannel('connected')
      expect(mocks.logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: 'control channel state: connecting → connected'
        })
      )
      useConnectionStatusStore.getState().setTerminalChannel('disconnected')
      expect(mocks.logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'terminal channel state: connected → disconnected'
        })
      )
    })

    it('does not log when the state is unchanged', () => {
      useConnectionStatusStore.getState().setTerminalChannel('connected')
      expect(mocks.logFrontendError).not.toHaveBeenCalled()
    })
  })

  describe('wireConnectionStatusTracking (Tauri desktop)', () => {
    it('is a no-op — no listeners are registered', () => {
      mocks.isTauriContext.mockReturnValue(true)
      wireConnectionStatusTracking()
      expect(mocks.acpListener).not.toHaveBeenCalled()
      expect(mocks.terminalListener).not.toHaveBeenCalled()
    })
  })
})
