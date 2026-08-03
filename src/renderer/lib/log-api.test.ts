import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('./tauri-runtime', () => ({
  isTauriContext: vi.fn()
}))

vi.mock('./web-server-api', () => ({
  webServerLog: { frontendError: vi.fn() }
}))

import { invoke } from '@tauri-apps/api/core'
import { installGlobalErrorForwarding, logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'
import { webServerLog } from './web-server-api'

const mockInvoke = invoke as ReturnType<typeof vi.fn>
const mockIsTauriContext = isTauriContext as ReturnType<typeof vi.fn>
const mockFrontendError = webServerLog.frontendError as ReturnType<typeof vi.fn>

describe('logFrontendError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    mockFrontendError.mockResolvedValue(undefined)
  })

  it('desktop: invokes log_frontend_error with defaults applied', async () => {
    mockIsTauriContext.mockReturnValue(true)
    await logFrontendError({ message: 'boom' })

    expect(mockInvoke).toHaveBeenCalledWith('log_frontend_error', {
      level: 'error',
      message: 'boom',
      source: 'renderer',
      stack: null,
      componentStack: null
    })
    expect(mockFrontendError).not.toHaveBeenCalled()
  })

  it('desktop: passes through level, source, stack, and component stack', async () => {
    mockIsTauriContext.mockReturnValue(true)
    await logFrontendError({
      level: 'warn',
      message: 'render failed',
      source: 'ErrorBoundary:Terminal',
      stack: 'Error: render failed\n  at X',
      componentStack: '\n  in Pane'
    })

    expect(mockInvoke).toHaveBeenCalledWith('log_frontend_error', {
      level: 'warn',
      message: 'render failed',
      source: 'ErrorBoundary:Terminal',
      stack: 'Error: render failed\n  at X',
      componentStack: '\n  in Pane'
    })
  })

  it('desktop: never throws when the backend command rejects', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockRejectedValue(new Error('ipc down'))
    await expect(logFrontendError({ message: 'x' })).resolves.toBeUndefined()
  })

  it('web: posts to /log/frontend-error via webServerLog with defaults applied', async () => {
    mockIsTauriContext.mockReturnValue(false)
    await logFrontendError({ message: 'boom' })

    expect(mockFrontendError).toHaveBeenCalledWith({
      level: 'error',
      message: 'boom',
      source: 'renderer',
      stack: undefined,
      componentStack: undefined
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('web: passes through level, source, stack, and component stack', async () => {
    mockIsTauriContext.mockReturnValue(false)
    await logFrontendError({
      level: 'warn',
      message: 'render failed',
      source: 'ErrorBoundary:Terminal',
      stack: 'Error: render failed\n  at X',
      componentStack: '\n  in Pane'
    })

    expect(mockFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      message: 'render failed',
      source: 'ErrorBoundary:Terminal',
      stack: 'Error: render failed\n  at X',
      componentStack: '\n  in Pane'
    })
  })

  it('web: never throws when the server route rejects', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFrontendError.mockRejectedValue(new Error('network down'))
    await expect(logFrontendError({ message: 'x' })).resolves.toBeUndefined()
  })
})

describe('installGlobalErrorForwarding', () => {
  // The facade guards against double registration with a module-level flag, so
  // install exactly once here and capture the registered handlers up front.
  const addEventListener = vi.spyOn(window, 'addEventListener')
  installGlobalErrorForwarding()

  const errorHandler = addEventListener.mock.calls.find((c) => c[0] === 'error')?.[1] as (
    e: Partial<ErrorEvent>
  ) => void
  const rejectionHandler = addEventListener.mock.calls.find(
    (c) => c[0] === 'unhandledrejection'
  )?.[1] as (e: Partial<PromiseRejectionEvent>) => void

  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    mockFrontendError.mockResolvedValue(undefined)
  })

  it('registers error and unhandledrejection listeners', () => {
    expect(errorHandler).toBeTypeOf('function')
    expect(rejectionHandler).toBeTypeOf('function')
  })

  it('is idempotent — a second call registers nothing new', () => {
    const countBefore = addEventListener.mock.calls.length
    installGlobalErrorForwarding()
    expect(addEventListener.mock.calls.length).toBe(countBefore)
  })

  it('desktop: forwards window error events to the backend log', () => {
    mockIsTauriContext.mockReturnValue(true)
    errorHandler({ error: new Error('uncaught'), message: 'uncaught' })

    expect(mockInvoke).toHaveBeenCalledWith(
      'log_frontend_error',
      expect.objectContaining({ source: 'window.onerror', message: 'uncaught' })
    )
  })

  it('desktop: forwards unhandled promise rejections to the backend log', () => {
    mockIsTauriContext.mockReturnValue(true)
    rejectionHandler({ reason: new Error('rejected') })

    expect(mockInvoke).toHaveBeenCalledWith(
      'log_frontend_error',
      expect.objectContaining({ source: 'unhandledrejection', message: 'rejected' })
    )
  })

  it('web: forwards window error events to the server log', () => {
    mockIsTauriContext.mockReturnValue(false)
    errorHandler({ error: new Error('uncaught'), message: 'uncaught' })

    expect(mockFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'window.onerror', message: 'uncaught' })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('web: forwards unhandled promise rejections to the server log', () => {
    mockIsTauriContext.mockReturnValue(false)
    rejectionHandler({ reason: new Error('rejected') })

    expect(mockFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'unhandledrejection', message: 'rejected' })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('skips resource-load failures (no error object, empty message)', () => {
    mockIsTauriContext.mockReturnValue(true)
    errorHandler({ error: null, message: '' })
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
