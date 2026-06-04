import type { ITheme, Terminal } from '@xterm/xterm'

/** Apply xterm theme and force a full repaint (canvas + WebGL). */
export function applyThemeToTerminal(terminal: Terminal, theme: ITheme): void {
  terminal.options.theme = theme
  const end = Math.max(0, terminal.rows - 1)
  terminal.refresh(0, end)
}
