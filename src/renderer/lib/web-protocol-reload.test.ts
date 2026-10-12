import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetProtocolMismatchForTesting,
  clearProtocolMismatchLatch,
  handleProtocolVersionMismatch,
  PROTOCOL_RELOAD_LATCH_KEY
} from './web-protocol-reload'

const mockLogFrontendError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

describe('handleProtocolVersionMismatch', () => {
  const reload = vi.fn()

  beforeEach(() => {
    window.sessionStorage.clear()
    __resetProtocolMismatchForTesting()
    reload.mockClear()
    mockLogFrontendError.mockClear()
    vi.stubGlobal('location', { host: 'host.test:8080', reload })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reloads once on the first mismatch and arms the loop latch', () => {
    expect(handleProtocolVersionMismatch('Test')).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(PROTOCOL_RELOAD_LATCH_KEY)).not.toBeNull()
  })

  it('coalesces mismatches from several sockets in one page into a single reload', () => {
    expect(handleProtocolVersionMismatch('WsAcpTransport')).toBe('reloading')
    expect(handleProtocolVersionMismatch('WebTerminalClient')).toBe('reloading')
    expect(handleProtocolVersionMismatch('WebStoreSocket')).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload again after the reload when the host still refuses (latch blocks), and logs a terminal error', () => {
    handleProtocolVersionMismatch('Test')
    expect(reload).toHaveBeenCalledTimes(1)

    // The reloaded page: fresh module state, same sessionStorage.
    __resetProtocolMismatchForTesting()
    expect(handleProtocolVersionMismatch('Test')).toBe('halted')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', source: 'Test.protocolMismatch' })
    )
  })

  it('a success while a mismatch reload is pending keeps the loop latch', () => {
    handleProtocolVersionMismatch('WebTerminalClient')
    clearProtocolMismatchLatch()
    expect(window.sessionStorage.getItem(PROTOCOL_RELOAD_LATCH_KEY)).not.toBeNull()
  })

  it('a successful handshake clears the latch so a later host upgrade can reload again', () => {
    handleProtocolVersionMismatch('Test')
    // The reload happened: the new page starts with fresh module state.
    __resetProtocolMismatchForTesting()
    clearProtocolMismatchLatch()
    expect(window.sessionStorage.getItem(PROTOCOL_RELOAD_LATCH_KEY)).toBeNull()
    expect(handleProtocolVersionMismatch('Test')).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('refuses to reload when the latch cannot be persisted (no reload-storm risk)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(handleProtocolVersionMismatch('Test')).toBe('halted')
    expect(reload).not.toHaveBeenCalled()
  })
})
