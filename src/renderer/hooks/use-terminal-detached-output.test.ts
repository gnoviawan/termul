import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTerminalDetachedOutput } from './use-terminal-detached-output'

const { mockOnData, mockAppendTranscript } = vi.hoisted(() => ({
  mockOnData: vi.fn(),
  mockAppendTranscript: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    onData: mockOnData
  }
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: vi.fn(() => ({
      appendTranscript: mockAppendTranscript
    }))
  }
}))

describe('useTerminalDetachedOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('captures PTY output into transcript when no renderer is mounted', () => {
    const unsubscribe = vi.fn()
    let capturedCallback: ((ptyId: string, data: string) => void) | undefined

    mockOnData.mockImplementation((callback: (ptyId: string, data: string) => void) => {
      capturedCallback = callback
      return unsubscribe
    })

    const { unmount } = renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', 'streaming output')

    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'streaming output')

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('ignores empty terminal-data payloads', () => {
    let capturedCallback: ((ptyId: string, data: string) => void) | undefined

    mockOnData.mockImplementation((callback: (ptyId: string, data: string) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', '')

    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })
})
