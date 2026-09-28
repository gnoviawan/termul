import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tauri-runtime', () => ({
  isTauriContext: vi.fn()
}))

vi.mock('./log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

import { logFrontendError } from './log-api'
import { registerServiceWorker } from './pwa-register'
import { isTauriContext } from './tauri-runtime'

const mockIsTauriContext = isTauriContext as ReturnType<typeof vi.fn>
const mockLog = logFrontendError as ReturnType<typeof vi.fn>

// Capture the `load` listener the module registers instead of dispatching a
// real event on `window` — listeners accumulate across tests on the shared
// jsdom window, so invoking the captured handler keeps each test isolated.
const addEventListenerSpy = vi.spyOn(window, 'addEventListener')

const ORIGINAL_SECURE_CONTEXT = window.isSecureContext
const ORIGINAL_READY_STATE = document.readyState

let register: ReturnType<typeof vi.fn>

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true })
}

function setReadyState(value: string): void {
  Object.defineProperty(document, 'readyState', { value, configurable: true })
}

function installServiceWorker(): void {
  register = vi.fn(() => Promise.resolve({}))
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register },
    configurable: true
  })
}

function removeServiceWorker(): void {
  delete (navigator as any).serviceWorker
}

/** Restore console.info/console.warn if a test spied on them. */
function restoreConsole(): void {
  for (const method of ['info', 'warn'] as const) {
    const fn = console[method] as unknown as { mockRestore?: () => void }
    fn.mockRestore?.()
  }
}

/** Every `load` listener registration seen so far (accumulates across tests). */
function loadCalls(): unknown[][] {
  return addEventListenerSpy.mock.calls.filter((c) => c[0] === 'load')
}

describe('registerServiceWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    setSecureContext(true)
    setReadyState('loading')
    installServiceWorker()
  })

  afterEach(() => {
    restoreConsole()
    removeServiceWorker()
    setSecureContext(ORIGINAL_SECURE_CONTEXT)
    setReadyState(ORIGINAL_READY_STATE)
  })

  it('Tauri desktop context: never registers, never requests /sw.js', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    mockIsTauriContext.mockReturnValue(true)
    const before = loadCalls().length
    registerServiceWorker()

    expect(register).not.toHaveBeenCalled()
    expect(loadCalls().length).toBe(before)
    expect(mockLog).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('insecure context (http:// LAN): skips registration, logs console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    setSecureContext(false)
    const before = loadCalls().length
    registerServiceWorker()

    expect(register).not.toHaveBeenCalled()
    expect(loadCalls().length).toBe(before)
    // The backend log endpoint is loopback-gated — an insecure context is a
    // non-loopback http:// origin where the POST would be refused — so the
    // skip is reported locally via console.info, NOT logFrontendError.
    expect(info).toHaveBeenCalledWith(expect.stringContaining('insecure context'))
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('missing serviceWorker support: skips registration, logs console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    removeServiceWorker()
    const before = loadCalls().length
    registerServiceWorker()

    expect(loadCalls().length).toBe(before)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('unsupported'))
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('happy path: registers /sw.js on window load', () => {
    const before = loadCalls().length
    registerServiceWorker()

    // Deferred until load — nothing registered synchronously.
    expect(register).not.toHaveBeenCalled()
    const handler = loadCalls()[before]?.[1] as (() => void) | undefined
    expect(handler).toBeTypeOf('function')

    handler!()
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('/sw.js')
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('registers immediately when the document is already complete', () => {
    setReadyState('complete')
    const before = loadCalls().length
    registerServiceWorker()

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('/sw.js')
    expect(loadCalls().length).toBe(before)
  })

  it('registration rejection → warn log via logFrontendError + console.warn, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    register.mockRejectedValue(new Error('quota exceeded'))
    const before = loadCalls().length
    registerServiceWorker()
    const handler = loadCalls()[before]?.[1] as (() => void) | undefined
    expect(handler).toBeTypeOf('function')
    handler!()

    await vi.waitFor(() => {
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'pwa-register',
          message: expect.stringContaining('quota exceeded')
        })
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('quota exceeded'))
    })
  })

  it('a synchronous register() throw is caught and logged, never escapes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setReadyState('complete')
    register.mockImplementation(() => {
      throw new Error('blocked by browser policy')
    })

    expect(() => registerServiceWorker()).not.toThrow()

    await vi.waitFor(() => {
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'pwa-register',
          message: expect.stringContaining('blocked by browser policy')
        })
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('blocked by browser policy'))
    })
  })
})
