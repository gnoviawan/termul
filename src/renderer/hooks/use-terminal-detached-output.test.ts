import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalDetachedOutput } from './use-terminal-detached-output'

const { mockOnData, mockAppendTranscript, mockFindTerminalByPtyId } = vi.hoisted(() => ({
  mockOnData: vi.fn(),
  mockAppendTranscript: vi.fn(),
  mockFindTerminalByPtyId: vi.fn()
}))

/** Convert a string to Uint8Array for binary channel test data */
function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

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
    let capturedCallback: ((ptyId: string, data: Uint8Array) => void) | undefined

    mockOnData.mockImplementation((callback: (ptyId: string, data: Uint8Array) => void) => {
      capturedCallback = callback
      return unsubscribe
    })

    const { unmount } = renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', toBytes('streaming output'))

    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'streaming output')

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('skips transcript capture for visible terminals with an attached renderer', () => {
    let capturedCallback: ((ptyId: string, data: Uint8Array) => void) | undefined

    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: false })
    mockOnData.mockImplementation((callback: (ptyId: string, data: Uint8Array) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', toBytes('visible output'))

    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('does not capture PTY output when app is hidden but a renderer is still attached', () => {
    let capturedCallback: ((ptyId: string, data: Uint8Array) => void) | undefined

    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: true })
    mockOnData.mockImplementation((callback: (ptyId: string, data: Uint8Array) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', toBytes('hidden output'))

    // Transcript is only for detached terminals (project switch).
    // When a renderer IS attached, data flows through xterm naturally
    // and will resume when the app becomes visible again.
    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('ignores empty terminal-data payloads', () => {
    let capturedCallback: ((ptyId: string, data: Uint8Array) => void) | undefined

    mockOnData.mockImplementation((callback: (ptyId: string, data: Uint8Array) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-a', new Uint8Array(0))

    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('ignores data for unknown PTY (store record missing)', () => {
    let capturedCallback: ((ptyId: string, data: Uint8Array) => void) | undefined

    mockFindTerminalByPtyId.mockReturnValue(undefined)
    mockOnData.mockImplementation((callback: (ptyId: string, data: Uint8Array) => void) => {
      capturedCallback = callback
      return vi.fn()
    })

    renderHook(() => useTerminalDetachedOutput())

    capturedCallback?.('pty-x', toBytes('late data'))

    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })
})
