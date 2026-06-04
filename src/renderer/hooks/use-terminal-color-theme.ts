import type { Terminal } from '@xterm/xterm'
import { useEffect } from 'react'
import {
  applyThemeToTerminal,
  COLOR_THEME_CHANGED_EVENT,
  getActiveTerminalTheme
} from '@/lib/themes'

/** Keep a terminal instance in sync with the active color theme (attach + live updates). */
export function useTerminalColorTheme(terminal: Terminal | null): void {
  useEffect(() => {
    if (!terminal) return
    applyThemeToTerminal(terminal, getActiveTerminalTheme())
  }, [terminal])

  useEffect(() => {
    if (!terminal) return

    const onThemeChanged = (): void => {
      applyThemeToTerminal(terminal, getActiveTerminalTheme())
    }

    window.addEventListener(COLOR_THEME_CHANGED_EVENT, onThemeChanged)
    return () => {
      window.removeEventListener(COLOR_THEME_CHANGED_EVENT, onThemeChanged)
    }
  }, [terminal])
}
