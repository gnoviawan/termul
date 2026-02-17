import { useState, useCallback, useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'

export interface UseTerminalClipboardOptions {
  terminal: Terminal | null
}

export interface UseTerminalClipboardReturn {
  copySelection: () => Promise<void>
  pasteFromClipboard: () => Promise<void>
  hasSelection: boolean
}

// Maximum clipboard content size (10MB)
const MAX_CLIPBOARD_SIZE = 10 * 1024 * 1024

export function useTerminalClipboard(
  options: UseTerminalClipboardOptions
): UseTerminalClipboardReturn {
  const { terminal } = options
  const [hasSelection, setHasSelection] = useState<boolean>(false)
  // Use a ref to track the current terminal instance for async operations
  const terminalRef = useRef<Terminal | null>(terminal)

  // Keep terminalRef in sync with terminal prop
  useEffect(() => {
    terminalRef.current = terminal
  }, [terminal])

  // Hook into xterm.js selection events
  useEffect(() => {
    // Cleanup function reference
    let cleanupFn: (() => void) | null = null

    if (!terminal) {
      setHasSelection(false)
      return
    }

    // Check initial selection state
    setHasSelection(terminal.hasSelection())

    // Subscribe to selection change events
    const disposable = terminal.onSelectionChange(() => {
      setHasSelection(terminal.hasSelection())
    })

    cleanupFn = () => disposable.dispose()

    return () => {
      if (cleanupFn) {
        cleanupFn()
      }
    }
  }, [terminal])

  // Copy current terminal selection to clipboard
  const copySelection = useCallback(async (): Promise<void> => {
    const currentTerminal = terminalRef.current
    if (!currentTerminal) return

    const selection = currentTerminal.getSelection()
    if (!selection) return

    // Validate selection size
    if (selection.length > MAX_CLIPBOARD_SIZE) {
      console.error('Selection too large for clipboard')
      return
    }

    const result = await window.api.clipboard.writeText(selection)
    if (!result.success) {
      console.error('Failed to copy to clipboard:', result.error)
    }
  }, [])

  // Track if paste is in progress to prevent double-paste
  const isPastingRef = useRef(false)

  // Paste from clipboard to terminal
  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    // Prevent concurrent paste operations
    if (isPastingRef.current) return
    
    const currentTerminal = terminalRef.current
    if (!currentTerminal) return

    isPastingRef.current = true
    
    try {
      const result = await window.api.clipboard.readText()
      if (result.success && result.data) {
        // Validate clipboard content size
        if (result.data.length > MAX_CLIPBOARD_SIZE) {
          console.error('Clipboard content too large')
          return
        }
        currentTerminal.paste(result.data)
      } else if (!result.success) {
        console.error('Failed to read from clipboard:', result.error)
      }
    } finally {
      // Reset after a short delay to prevent rapid successive calls
      setTimeout(() => {
        isPastingRef.current = false
      }, 100)
    }
  }, [])

  return {
    copySelection,
    pasteFromClipboard,
    hasSelection
  }
}
