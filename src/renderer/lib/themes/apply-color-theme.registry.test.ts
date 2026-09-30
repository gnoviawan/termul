import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRegistry, forEachTerminal, registerTerminal } from '@/utils/terminal-registry'
import { applyColorTheme, paletteToXtermTheme } from './apply-color-theme'
import { applyThemeToTerminal } from './apply-theme-to-terminal'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'

vi.mock('./apply-theme-to-terminal', () => ({
  applyThemeToTerminal: vi.fn()
}))

describe('applyColorTheme registry path', () => {
  beforeEach(() => {
    clearRegistry()
    vi.mocked(applyThemeToTerminal).mockClear()
  })

  it('applies theme to every registered terminal', () => {
    const terminalA = { options: {} } as Terminal
    const terminalB = { options: {} } as Terminal
    registerTerminal('a', terminalA)
    registerTerminal('b', terminalB)

    applyColorTheme('dracula')

    expect(applyThemeToTerminal).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(applyThemeToTerminal).mock.calls
    expect(calls[0]?.[0]).toBe(terminalA)
    expect(calls[1]?.[0]).toBe(terminalB)
    expect(calls[0]?.[1]?.background).toBe(
      paletteToXtermTheme(BUNDLED_COLOR_THEMES.dracula.dark.palette, 'dark').background
    )

    forEachTerminal((terminal) => {
      expect([terminalA, terminalB]).toContain(terminal)
    })
  })
})
