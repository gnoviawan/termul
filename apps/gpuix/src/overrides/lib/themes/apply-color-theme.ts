/**
 * GPUIX `apply-color-theme`: the same exports, with the document writes
 * (CSS custom properties, the `dark` class, the transition-suppressing
 * `<style>`) replaced by switching the theme the compat translator and tw()
 * resolve against. Terminals and the theme-changed event are as on the web.
 */

import { forEachTerminal } from '@/utils/terminal-registry'
import { applyThemeToTerminal } from '@/lib/themes/apply-theme-to-terminal'
import { DEFAULT_COLOR_THEME_ID, getColorThemeDefinition } from '@/lib/themes/bundled-themes'
import { resolveSyntaxColors } from '@/lib/themes/resolve-syntax'
import { COLOR_THEME_CHANGED_EVENT, type ColorThemeChangedDetail } from '@/lib/themes/types'
import { paletteToXtermTheme } from '@/lib/themes/apply-color-theme'
import { setCompatTheme } from '../../../compat/translate'
import { setTwTheme } from '../../../style/tw'

export {
  isKnownColorThemeId,
  paletteToXtermTheme,
  resolveThemeForTest
} from '@/lib/themes/apply-color-theme'

let lastAppliedThemeId = DEFAULT_COLOR_THEME_ID

export function getLastAppliedColorThemeId(): string {
  return lastAppliedThemeId
}

export function applyColorTheme(themeId: string): void {
  const theme = getColorThemeDefinition(themeId)
  const syntax = resolveSyntaxColors(theme)
  const xtermTheme = paletteToXtermTheme(theme.dark.palette, theme.appearance, theme.dark.chrome)
  setTwTheme(theme.id)
  setCompatTheme(theme.id)
  forEachTerminal((terminal) => applyThemeToTerminal(terminal, xtermTheme))
  lastAppliedThemeId = theme.id
  window.dispatchEvent(
    new CustomEvent<ColorThemeChangedDetail>(COLOR_THEME_CHANGED_EVENT, { detail: { themeId: theme.id, syntax } })
  )
}

export function getActiveTerminalTheme(): ReturnType<typeof paletteToXtermTheme> {
  const theme = getColorThemeDefinition(lastAppliedThemeId)
  return paletteToXtermTheme(theme.dark.palette, theme.appearance, theme.dark.chrome)
}
