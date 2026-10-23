/**
 * Termul's terminal palette for a theme id, from the same code the DOM client
 * feeds xterm (`paletteToXtermTheme`). Imported directly rather than through
 * `@/lib/themes` so the DOM-writing `applyColorTheme` path stays out of the
 * bun process.
 */
import type { ITheme } from '@xterm/headless'
import { paletteToXtermTheme } from '@/lib/themes/apply-color-theme'
import { getColorThemeDefinition } from '@/lib/themes/bundled-themes'

export const DEFAULT_TERMINAL_THEME_ID = 'termul'

export function terminalThemeFor(themeId = DEFAULT_TERMINAL_THEME_ID): ITheme {
  const theme = getColorThemeDefinition(themeId)
  return paletteToXtermTheme(theme.dark.palette, theme.appearance, theme.dark.chrome)
}
