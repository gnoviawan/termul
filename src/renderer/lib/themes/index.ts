export {
  applyColorTheme,
  getActiveTerminalTheme,
  getLastAppliedColorThemeId
} from './apply-color-theme'
export {
  BUNDLED_COLOR_THEMES,
  COLOR_THEME_LIST,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition
} from './bundled-themes'
export { resolveSyntaxColors } from './resolve-syntax'
export type {
  ColorThemeChangedDetail,
  ColorThemeDefinition,
  ResolvedSyntaxColors,
  ThemePalette
} from './types'
export { COLOR_THEME_CHANGED_EVENT } from './types'
