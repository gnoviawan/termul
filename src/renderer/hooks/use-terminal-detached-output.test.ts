import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTerminalDetachedOutput } from './use-terminal-detached-output'

const { mockOnData, mockAppendTranscript, mockFindTerminalByPtyId } = vi.hoisted(() => ({
  mockOnData: vi.fn(),
  mockAppendTranscript: vi.fn(),
  mockFindTerminalByPtyId: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    onData: mockOnData
  }
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: vi.fn(() => ({
      appendTranscript: mockAppendTranscript,
      findTerminalByPtyId: mockFindTerminalByPtyId
    }))
  }
}))

describe('useTerminalDetachedOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 0, isAppHidden: false })
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

  it('skips transcript capture for visible terminals with an attached renderer', () => {
    let capturedCallback: ((ptyId: string, data: string) => void) | undefined

    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: false })
    mockOnData.mockImplementation((callback: (ptyId: string, data: string) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', 'visible output')

    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('does not capture PTY output when app is hidden but a renderer is still attached', () => {
    let capturedCallback: ((ptyId: string, data: string) => void) | undefined

    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: true })
    mockOnData.mockImplementation((callback: (ptyId: string, data: string) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', 'hidden output')

    // Transcript is only for detached terminals (project switch).
    // When a renderer IS attached, data flows through xterm naturally
    // and will resume when the app becomes visible again.
    expect(mockAppendTranscript).not.toHaveBeenCalled()
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
