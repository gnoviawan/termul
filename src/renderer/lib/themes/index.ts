export {
  applyColorTheme,
  getActiveTerminalTheme,
  getLastAppliedColorThemeId
} from './apply-color-theme'
export { applyThemeToTerminal } from './apply-theme-to-terminal'
export {
  BUNDLED_COLOR_THEMES,
  COLOR_THEME_FAMILIES,
  COLOR_THEME_LIST,
  type ColorThemeFamily,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition,
  THEME_PICKER_ROWS,
  type ThemePickerRow
} from './bundled-themes'
export { deriveSurfaces } from './derive-surfaces'
export { resolveSyntaxColors } from './resolve-syntax'
export {
  type AppearanceMode,
  getEffectiveThemeId,
  getLightThemeId,
  getPickerApplySettings,
  getSystemAppearance,
  normalizeThemeFamilyId,
  resolveAppearanceMode,
  type ThemeAppearance
} from './theme-appearance'
export type {
  ColorThemeChangedDetail,
  ColorThemeDefinition,
  ResolvedSyntaxColors,
  ThemePalette
} from './types'
export { COLOR_THEME_CHANGED_EVENT } from './types'
