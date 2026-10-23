/**
 * The shared terminal modules (`utils/terminal-registry`, `terminal-cache`,
 * `applyColorTheme`, snapshots, autosave) hold `@xterm/xterm` Terminals. A
 * native screen enters them as this facade: the members those modules read,
 * backed by the headless terminal (same core: buffer, parser, modes, write,
 * scrollToLine) and by the screen (theme, refresh, selection, dispose).
 *
 * Members read by the shared code (keep in sync when it grows):
 * registry `buffer`, `parser`, `write`, `scrollToLine`; cache `element`,
 * `dispose`; theme `options.theme`, `rows`, `refresh`; snapshots `buffer`.
 */
import type { ITheme, Terminal as XtermTerminal } from '@xterm/xterm'
import type { TerminalScreen } from './screen'

const screens = new WeakMap<object, TerminalScreen>()
const facades = new WeakMap<TerminalScreen, XtermTerminal>()

export function asXterm(screen: TerminalScreen): XtermTerminal {
  const existing = facades.get(screen)
  if (existing) return existing
  const terminal = screen.terminal
  let theme: ITheme | undefined
  const facade = {
    element: undefined,
    get buffer() {
      return terminal.buffer
    },
    get parser() {
      return terminal.parser
    },
    get modes() {
      return terminal.modes
    },
    get cols() {
      return terminal.cols
    },
    get rows() {
      return terminal.rows
    },
    options: {
      get theme() {
        return theme
      },
      set theme(next: ITheme | undefined) {
        theme = next
        if (next) screen.setTheme(next)
      }
    },
    write: (data: string | Uint8Array, callback?: () => void) => screen.write(data, callback),
    scrollToLine: (line: number) => screen.scrollToLine(line),
    refresh: () => screen.refresh(),
    hasSelection: () => screen.selectedText() !== '',
    getSelection: () => screen.selectedText(),
    selectAll: () => screen.selectAll(),
    dispose: () => screen.dispose()
  }
  screens.set(facade, screen)
  // The facade is the subset listed above; the shared modules never call the rest.
  const typed = facade as unknown as XtermTerminal
  facades.set(screen, typed)
  return typed
}

/** The screen behind a facade from `asXterm`, or undefined for anything else. */
export function screenOf(terminal: XtermTerminal | undefined): TerminalScreen | undefined {
  return terminal ? screens.get(terminal) : undefined
}
