import type { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import { clipboardApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'

export interface UseTerminalClipboardOptions {
  terminal: Terminal | null
  pasteText?: (text: string) => Promise<void> | void
  onImagePaste?: () => Promise<void> | void
}

export interface UseTerminalClipboardReturn {
  copySelection: () => Promise<void>
  pasteFromClipboard: () => Promise<void>
  hasSelection: boolean
}

// Maximum clipboard content size (10MB)
const MAX_CLIPBOARD_SIZE = 10 * 1024 * 1024
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// F2: warn once when the menu/toolbar paste path is gated off in a non-secure
// context (the Async Clipboard API is unavailable and a click can't trigger a
// paste event). The Ctrl+V keydown path is unaffected (it returns true to
// native xterm paste before reaching this hook's readText).
let warnedNonSecureMenuPaste = false

function normalizePasteText(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

// Sanitize ESC characters to prevent injected escape sequences from exiting
// the bracketed paste region. Matches xterm.js's bracketTextForPaste() behavior
// (replaces \x1b with its visible representation U+241B = ␛).
function sanitizeEscapeSequences(text: string): string {
  return text.split(String.fromCharCode(0x1b)).join('\u241b')
}

export function useTerminalClipboard(
  options: UseTerminalClipboardOptions
): UseTerminalClipboardReturn {
  const { terminal, pasteText, onImagePaste } = options
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

    const result = await clipboardApi.writeText(selection)
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

    // F2: the menu/toolbar "Paste" path calls readText() directly. In a
    // non-secure context the Async Clipboard API is undefined and a click
    // can't produce the paste event the facade's fallback waits on — so
    // readText would hang 5s then READ_ERROR. Fail fast (no-op) instead.
    // The Ctrl+V keydown path is unaffected (it returns true to native
    // xterm paste in ConnectedTerminal before reaching this hook).
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard === 'undefined') {
      if (!warnedNonSecureMenuPaste) {
        warnedNonSecureMenuPaste = true
        void logFrontendError({
          level: 'warn',
          message:
            'Menu/toolbar paste unavailable in non-secure context (no navigator.clipboard); use Ctrl+V',
          source: 'use-terminal-clipboard'
        })
      }
      return
    }

    isPastingRef.current = true

    try {
      // Check for image first - if present, delegate to onImagePaste callback
      const imageResult = await clipboardApi.hasImage()
      if (imageResult.success && imageResult.data && onImagePaste) {
        await onImagePaste()
        return
      }

      const result = await clipboardApi.readText()
      if (result.success && result.data) {
        // Validate clipboard content size
        if (result.data.length > MAX_CLIPBOARD_SIZE) {
          console.error('Clipboard content too large')
          return
        }
        const normalizedText = normalizePasteText(result.data)
        if (pasteText) {
          const sanitizedText = sanitizeEscapeSequences(normalizedText)
          await pasteText(`${BRACKETED_PASTE_START}${sanitizedText}${BRACKETED_PASTE_END}`)
        } else {
          currentTerminal.paste(normalizedText)
        }
      } else if (!result.success) {
        console.error('Failed to read from clipboard:', result.error)
      }
    } finally {
      // Reset after a short delay to prevent rapid successive calls
      setTimeout(() => {
        isPastingRef.current = false
      }, 100)
    }
  }, [pasteText, onImagePaste])

  return {
    copySelection,
    pasteFromClipboard,
    hasSelection
  }
}
