import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeUiLanguage } from '@/i18n'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import { logFrontendError } from '@/lib/log-api'
import { ErrorBoundary } from './ErrorBoundary'

const mockLog = logFrontendError as ReturnType<typeof vi.fn>

function Bomb(): never {
  throw new Error('render exploded')
}

describe('ErrorBoundary error forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Silence the boundary's own console.error noise during the test.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    await changeUiLanguage('en')
  })

  it('forwards caught render errors to the backend log with the context label', () => {
    render(
      <ErrorBoundary context="terminalPane">
        <Bomb />
      </ErrorBoundary>
    )

    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ErrorBoundary:terminalPane',
        message: 'render exploded'
      })
    )
    // Component stack is captured for boundary errors.
    expect(mockLog.mock.calls[0][0]).toHaveProperty('componentStack')
  })

  it('renders the fallback UI instead of crashing', () => {
    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    )
    expect(container.textContent).toBeTruthy()
  })

  it('localizes stable context keys in the fallback UI', async () => {
    await changeUiLanguage('zh-CN')

    render(
      <ErrorBoundary context="terminalPane">
        <Bomb />
      </ErrorBoundary>
    )

    expect(screen.getByText(/终端窗格/)).toBeTruthy()
  })
})
