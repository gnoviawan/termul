import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

import { invoke } from '@tauri-apps/api/core'
import { installGlobalErrorForwarding, logFrontendError } from './log-api'

const mockInvoke = invoke as ReturnType<typeof vi.fn>

describe('logFrontendError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
  })

  it('invokes log_frontend_error with defaults applied', async () => {
    await logFrontendError({ message: 'boom' })

    expect(mockInvoke).toHaveBeenCalledWith('log_frontend_error', {
      level: 'error',
      message: 'boom',
      source: 'renderer',
      stack: null,
      componentStack: null
    })
  })

  it('passes through level, source, stack, and component stack', async () => {
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

  it('never throws when the backend command rejects', async () => {
    mockInvoke.mockRejectedValue(new Error('ipc down'))
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
    mockInvoke.mockClear()
    mockInvoke.mockResolvedValue(undefined)
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

  it('forwards window error events to the backend log', () => {
    errorHandler({ error: new Error('uncaught'), message: 'uncaught' })

    expect(mockInvoke).toHaveBeenCalledWith(
      'log_frontend_error',
      expect.objectContaining({ source: 'window.onerror', message: 'uncaught' })
    )
  })

  it('forwards unhandled promise rejections to the backend log', () => {
    rejectionHandler({ reason: new Error('rejected') })

    expect(mockInvoke).toHaveBeenCalledWith(
      'log_frontend_error',
      expect.objectContaining({ source: 'unhandledrejection', message: 'rejected' })
    )
  })

  it('skips resource-load failures (no error object, empty message)', () => {
    errorHandler({ error: null, message: '' })
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
