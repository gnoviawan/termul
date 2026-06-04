import type { Terminal } from '@xterm/xterm'
import { useEffect } from 'react'
import { applyThemeToTerminal, getActiveTerminalTheme } from '@/lib/themes'

/** Keep a terminal instance in sync with the active color theme (attach + live updates). */
export function useTerminalColorTheme(terminal: Terminal | null): void {
  useEffect(() => {
    if (!terminal) return
    applyThemeToTerminal(terminal, getActiveTerminalTheme())
  }, [terminal])
}
