/**
 * GPUIX override of `hooks/use-terminal-clipboard.ts`, same signature. The
 * terminal is a native screen behind its xterm facade, and the clipboard is
 * `terminal/clipboard.ts` (the system tool on PATH, else in-process memory)
 * because GPUIX has no JS clipboard API. Image paste is not detected: no
 * clipboard tool here reports MIME types in a portable way.
 */
import type { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import { log } from '../../log'
import { copyText, pasteText as readClipboard } from '../../terminal/clipboard'
import { screenOf } from '../../terminal/xterm-facade'

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

const MAX_CLIPBOARD_SIZE = 10 * 1024 * 1024
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

export function useTerminalClipboard(
  options: UseTerminalClipboardOptions
): UseTerminalClipboardReturn {
  const { terminal, pasteText } = options
  const screen = screenOf(terminal ?? undefined) ?? null
  const [hasSelection, setHasSelection] = useState(false)
  const screenRef = useRef(screen)
  screenRef.current = screen

  useEffect(() => {
    if (!screen) {
      setHasSelection(false)
      return
    }
    setHasSelection(screen.selectedText() !== '')
    return screen.onFrame(() => setHasSelection(screen.selectedText() !== ''))
  }, [screen])

  const copySelection = useCallback(async (): Promise<void> => {
    const selection = screenRef.current?.selectedText()
    if (!selection) return
    if (selection.length > MAX_CLIPBOARD_SIZE) {
      log.warn(
        'terminal',
        `clipboard.copy-too-large ${JSON.stringify({ length: selection.length })}`
      )
      return
    }
    await copyText(selection)
  }, [])

  const isPastingRef = useRef(false)
  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    if (isPastingRef.current) return
    const current = screenRef.current
    if (!current) return
    isPastingRef.current = true
    try {
      const text = await readClipboard()
      if (!text) return
      if (text.length > MAX_CLIPBOARD_SIZE) {
        log.warn('terminal', `clipboard.paste-too-large ${JSON.stringify({ length: text.length })}`)
        return
      }
      const normalized = text.replace(/\r?\n/g, '\r')
      if (pasteText) {
        // xterm's bracketTextForPaste: ESC becomes U+241B so the paste cannot leave the bracket.
        const sanitized = normalized.split('\x1b').join('␛')
        await pasteText(`${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}`)
      }
    } finally {
      setTimeout(() => {
        isPastingRef.current = false
      }, 100)
    }
  }, [pasteText])

  return { copySelection, pasteFromClipboard, hasSelection }
}
