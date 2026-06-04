import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { applyThemeToTerminal } from './apply-theme-to-terminal'

describe('applyThemeToTerminal', () => {
  it('sets options.theme and calls refresh', () => {
    const terminal = {
      options: { theme: {} },
      rows: 24,
      refresh: vi.fn()
    } as unknown as Terminal

    const theme = { background: '#111111', foreground: '#eeeeee' }
    applyThemeToTerminal(terminal, theme)

    expect(terminal.options.theme).toBe(theme)
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
  })
})
