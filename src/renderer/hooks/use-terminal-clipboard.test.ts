import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'

// Mock selection change callback
let capturedSelectionCallback: (() => void) | null = null

// Mock terminal instance with selection methods
const createMockTerminal = (hasSelectionValue = false, selectionText = '') => ({
  hasSelection: vi.fn(() => hasSelectionValue),
  getSelection: vi.fn(() => selectionText),
  paste: vi.fn(),
  selectAll: vi.fn(),
  onSelectionChange: vi.fn((cb: () => void) => {
    capturedSelectionCallback = cb
    return { dispose: vi.fn() }
  })
})

// Mock clipboard API
const mockClipboardApi = {
  readText: vi.fn<() => Promise<{ success: boolean; data?: string; error?: string }>>(),
  writeText: vi.fn<() => Promise<{ success: boolean; error?: string }>>()
}

// Setup window.api mock
Object.defineProperty(window, 'api', {
  value: {
    clipboard: mockClipboardApi
  },
  writable: true,
  configurable: true
})

import { useTerminalClipboard } from './use-terminal-clipboard'

describe('useTerminalClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedSelectionCallback = null
  })

  afterEach(() => {
    cleanup()
  })

  describe('initialization', () => {
    it('should initialize with hasSelection as false when terminal is null', () => {
      const { result } = renderHook(() => useTerminalClipboard({ terminal: null }))
      expect(result.current.hasSelection).toBe(false)
    })

    it('should initialize with hasSelection based on terminal state', () => {
      const mockTerminal = createMockTerminal(true, 'selected text')
      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))
      expect(result.current.hasSelection).toBe(true)
    })

    it('should return copySelection function', () => {
      const { result } = renderHook(() => useTerminalClipboard({ terminal: null }))
      expect(typeof result.current.copySelection).toBe('function')
    })

    it('should return pasteFromClipboard function', () => {
      const { result } = renderHook(() => useTerminalClipboard({ terminal: null }))
      expect(typeof result.current.pasteFromClipboard).toBe('function')
    })
  })

  describe('selection state management', () => {
    it('should update hasSelection when selection changes', () => {
      const mockTerminal = createMockTerminal(false, '')
      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      expect(result.current.hasSelection).toBe(false)

      // Simulate selection change
      mockTerminal.hasSelection.mockReturnValue(true)
      act(() => {
        capturedSelectionCallback?.()
      })

      expect(result.current.hasSelection).toBe(true)
    })

    it('should update hasSelection when selection is cleared', () => {
      const mockTerminal = createMockTerminal(true, 'selected text')
      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      expect(result.current.hasSelection).toBe(true)

      // Simulate selection cleared
      mockTerminal.hasSelection.mockReturnValue(false)
      act(() => {
        capturedSelectionCallback?.()
      })

      expect(result.current.hasSelection).toBe(false)
    })

    it('should reset hasSelection when terminal changes to null', () => {
      const mockTerminal = createMockTerminal(true, 'selected text')
      const { result, rerender } = renderHook(
        ({ terminal }) => useTerminalClipboard({ terminal }),
        { initialProps: { terminal: mockTerminal as unknown as Terminal } }
      )

      expect(result.current.hasSelection).toBe(true)

      rerender({ terminal: null as unknown as Terminal })

      expect(result.current.hasSelection).toBe(false)
    })

    it('should cleanup selection listener on unmount', () => {
      const disposeMock = vi.fn()
      const mockTerminal = {
        ...createMockTerminal(false, ''),
        onSelectionChange: vi.fn(() => ({ dispose: disposeMock }))
      }

      const { unmount } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))
      unmount()

      expect(disposeMock).toHaveBeenCalled()
    })
  })

  describe('copySelection', () => {
    it('should not call clipboard API when terminal is null', async () => {
      const { result } = renderHook(() => useTerminalClipboard({ terminal: null }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).not.toHaveBeenCalled()
    })

    it('should not call clipboard API when there is no selection', async () => {
      const mockTerminal = createMockTerminal(false, '')
      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).not.toHaveBeenCalled()
    })

    it('should write selection to clipboard when text is selected', async () => {
      const selectedText = 'Hello, World!'
      const mockTerminal = createMockTerminal(true, selectedText)
      mockClipboardApi.writeText.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).toHaveBeenCalledWith(selectedText)
    })

    it('should handle clipboard write failure gracefully', async () => {
      const selectedText = 'Hello, World!'
      const mockTerminal = createMockTerminal(true, selectedText)
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockClipboardApi.writeText.mockResolvedValue({ success: false, error: 'Clipboard access denied' })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).toHaveBeenCalledWith(selectedText)
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to copy to clipboard:', 'Clipboard access denied')

      consoleErrorSpy.mockRestore()
    })

    it('should copy multiline text correctly', async () => {
      const selectedText = 'Line 1\nLine 2\nLine 3'
      const mockTerminal = createMockTerminal(true, selectedText)
      mockClipboardApi.writeText.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).toHaveBeenCalledWith(selectedText)
    })

    it('should copy text with special characters correctly', async () => {
      const selectedText = 'Special: !@#$%^&*()_+-=[]{}|\';":",./<>?'
      const mockTerminal = createMockTerminal(true, selectedText)
      mockClipboardApi.writeText.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).toHaveBeenCalledWith(selectedText)
    })

    it('should not copy selection exceeding max size', async () => {
      const largeSelection = 'x'.repeat(11 * 1024 * 1024) // 11MB > 10MB limit
      const mockTerminal = createMockTerminal(true, largeSelection)
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.copySelection()
      })

      expect(mockClipboardApi.writeText).not.toHaveBeenCalled()
      expect(consoleErrorSpy).toHaveBeenCalledWith('Selection too large for clipboard')

      consoleErrorSpy.mockRestore()
    })
  })

  describe('pasteFromClipboard', () => {
    it('should not call clipboard API when terminal is null', async () => {
      const { result } = renderHook(() => useTerminalClipboard({ terminal: null }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockClipboardApi.readText).not.toHaveBeenCalled()
    })

    it('should paste clipboard content into terminal', async () => {
      const clipboardText = 'Pasted text'
      const mockTerminal = createMockTerminal(false, '')
      mockClipboardApi.readText.mockResolvedValue({ success: true, data: clipboardText })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockClipboardApi.readText).toHaveBeenCalled()
      expect(mockTerminal.paste).toHaveBeenCalledWith(clipboardText)
    })

    it('should not paste when clipboard is empty', async () => {
      const mockTerminal = createMockTerminal(false, '')
      mockClipboardApi.readText.mockResolvedValue({ success: true, data: '' })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockTerminal.paste).not.toHaveBeenCalled()
    })

    it('should handle clipboard read failure gracefully', async () => {
      const mockTerminal = createMockTerminal(false, '')
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockClipboardApi.readText.mockResolvedValue({ success: false, error: 'Clipboard access denied' })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockTerminal.paste).not.toHaveBeenCalled()
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to read from clipboard:', 'Clipboard access denied')

      consoleErrorSpy.mockRestore()
    })

    it('should paste multiline text correctly', async () => {
      const clipboardText = 'Line 1\nLine 2\nLine 3'
      const mockTerminal = createMockTerminal(false, '')
      mockClipboardApi.readText.mockResolvedValue({ success: true, data: clipboardText })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockTerminal.paste).toHaveBeenCalledWith(clipboardText)
    })

    it('should paste text with special characters correctly', async () => {
      const clipboardText = 'Special: !@#$%^&*()_+-=[]{}|\';":",./<>?'
      const mockTerminal = createMockTerminal(false, '')
      mockClipboardApi.readText.mockResolvedValue({ success: true, data: clipboardText })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockTerminal.paste).toHaveBeenCalledWith(clipboardText)
    })

    it('should paste code snippets correctly', async () => {
      const clipboardText = `function hello() {
  console.log("Hello, World!");
  return true;
}`
      const mockTerminal = createMockTerminal(false, '')
      mockClipboardApi.readText.mockResolvedValue({ success: true, data: clipboardText })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockTerminal.paste).toHaveBeenCalledWith(clipboardText)
    })

    it('should not paste content exceeding max size', async () => {
      const largeContent = 'x'.repeat(11 * 1024 * 1024) // 11MB > 10MB limit
      const mockTerminal = createMockTerminal(false, '')
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockClipboardApi.readText.mockResolvedValue({ success: true, data: largeContent })

      const { result } = renderHook(() => useTerminalClipboard({ terminal: mockTerminal as unknown as Terminal }))

      await act(async () => {
        await result.current.pasteFromClipboard()
      })

      expect(mockTerminal.paste).not.toHaveBeenCalled()
      expect(consoleErrorSpy).toHaveBeenCalledWith('Clipboard content too large')

      consoleErrorSpy.mockRestore()
    })
  })

  describe('terminal reference stability', () => {
    it('should maintain stable callback references', async () => {
      const mockTerminal = createMockTerminal(true, 'text')
      mockClipboardApi.writeText.mockResolvedValue({ success: true })

      const { result, rerender } = renderHook(
        ({ terminal }) => useTerminalClipboard({ terminal }),
        { initialProps: { terminal: mockTerminal as unknown as Terminal } }
      )

      const firstCopySelection = result.current.copySelection

      // Rerender with same terminal
      rerender({ terminal: mockTerminal as unknown as Terminal })

      const secondCopySelection = result.current.copySelection

      // Callbacks should be the same reference (memoized)
      expect(firstCopySelection).toBe(secondCopySelection)
    })

    it('should update callback when terminal changes', async () => {
      const mockTerminal1 = createMockTerminal(true, 'text1')
      const mockTerminal2 = createMockTerminal(true, 'text2')
      mockClipboardApi.writeText.mockResolvedValue({ success: true })

      const { result, rerender } = renderHook(
        ({ terminal }) => useTerminalClipboard({ terminal }),
        { initialProps: { terminal: mockTerminal1 as unknown as Terminal } }
      )

      // Copy from first terminal
      await act(async () => {
        await result.current.copySelection()
      })
      expect(mockClipboardApi.writeText).toHaveBeenCalledWith('text1')

      // Switch to second terminal
      rerender({ terminal: mockTerminal2 as unknown as Terminal })

      // Copy from second terminal
      await act(async () => {
        await result.current.copySelection()
      })
      expect(mockClipboardApi.writeText).toHaveBeenCalledWith('text2')
    })
  })
})
