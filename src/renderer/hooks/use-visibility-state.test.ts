import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisibilityState } from './use-visibility-state'

const {
  mockSetVisibilityState,
  mockSetAppHidden,
  mockTruncateHiddenTerminalBuffers,
  mockIsMinimized,
  mockOnFocusChanged,
  mockCleanupTauriListener,
  mockIsTauriContext,
  mockHiddenBufferTruncationDelay
} = vi.hoisted(() => ({
  mockSetVisibilityState: vi.fn(() => Promise.resolve()),
  mockSetAppHidden: vi.fn(),
  mockTruncateHiddenTerminalBuffers: vi.fn(),
  mockIsMinimized: vi.fn(() => Promise.resolve(false)),
  mockOnFocusChanged: vi.fn(() => Promise.resolve(vi.fn())),
  mockCleanupTauriListener: vi.fn(),
  mockIsTauriContext: vi.fn(() => false),
  mockHiddenBufferTruncationDelay: 1000
}))

vi.mock('@/lib/visibility-api', () => ({
  visibilityApi: {
    setVisibilityState: mockSetVisibilityState
  }
}))

vi.mock('@/stores/terminal-store', () => ({
  HIDDEN_BUFFER_TRUNCATION_DELAY: mockHiddenBufferTruncationDelay,
  useTerminalStore: {
    getState: vi.fn(() => ({
      setAppHidden: mockSetAppHidden,
      truncateHiddenTerminalBuffers: mockTruncateHiddenTerminalBuffers
    }))
  }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  cleanupTauriListener: mockCleanupTauriListener,
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMinimized: mockIsMinimized,
    onFocusChanged: mockOnFocusChanged
  })
}))

describe('useVisibilityState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('broadcasts initial visible state and marks app as visible', async () => {
    renderHook(() => useVisibilityState())

    await waitFor(() => {
      expect(mockSetAppHidden).toHaveBeenCalledWith(false)
      expect(mockSetVisibilityState).toHaveBeenCalledWith(true)
    })
  })

  it('does not rebroadcast when visibility state does not change', async () => {
    renderHook(() => useVisibilityState())

    await waitFor(() => {
      expect(mockSetVisibilityState).toHaveBeenCalledTimes(1)
    })

    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockSetVisibilityState).toHaveBeenCalledTimes(1)
  })

  it('marks the app hidden and broadcasts when document becomes hidden', async () => {
    renderHook(() => useVisibilityState())

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => {
      expect(mockSetAppHidden).toHaveBeenCalledWith(true)
    })

    expect(mockSetVisibilityState.mock.calls.some((call) => call[0 as number] === false)).toBe(true)
  })

  it('schedules hidden-state maintenance while the app stays hidden', () => {
    vi.useFakeTimers()

    renderHook(() => useVisibilityState())

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockSetAppHidden).toHaveBeenCalledWith(true)

    mockTruncateHiddenTerminalBuffers.mockClear()
    vi.advanceTimersByTime(mockHiddenBufferTruncationDelay + 1)

    expect(mockTruncateHiddenTerminalBuffers).toHaveBeenCalled()
  })

  it('uses Tauri minimize state as a visibility fallback', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockIsMinimized.mockResolvedValue(true)

    renderHook(() => useVisibilityState())

    await waitFor(() => {
      expect(mockIsMinimized).toHaveBeenCalled()
      expect(mockSetAppHidden).toHaveBeenCalledWith(true)
    })

    expect(mockSetVisibilityState.mock.calls.some((call) => call[0 as number] === false)).toBe(true)
  })

  it('does not emit an initial visible pulse before minimized state is known', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockIsMinimized.mockResolvedValue(true)

    renderHook(() => useVisibilityState())

    await waitFor(() => {
      expect(mockSetVisibilityState).toHaveBeenCalled()
    })

    expect(mockSetVisibilityState.mock.calls.at(0)?.at(0)).toBe(false)
  })
})
