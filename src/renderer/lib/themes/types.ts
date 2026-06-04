/** OpenCode-compatible desktop theme schema (subset used by Termul). */

export interface ThemePalette {
  neutral: string
  ink: string
  primary: string
  accent: string
  success: string
  warning: string
  error: string
  info: string
  diffAdd?: string
  diffDelete?: string
  interactive?: string
}

export type ThemeSyntaxOverrides = Partial<{
  'syntax-comment': string
  'syntax-keyword': string
  'syntax-function': string
  'syntax-string': string
  'syntax-primitive': string
  'syntax-variable': string
  'syntax-property': string
  'syntax-type': string
  'syntax-constant': string
  'syntax-operator': string
  'syntax-punctuation': string
}>

export interface ThemeVariant {
  palette: ThemePalette
  overrides?: ThemeSyntaxOverrides
}

export type ThemeAppearance = 'light' | 'dark'

export interface ColorThemeDefinition {
  id: string
  name: string
  /** UI + syntax variant (light or dark chrome). */
  appearance: ThemeAppearance
  /** Family base id (without `-light` suffix). */
  familyId: string
  /** Active palette + syntax overrides for this entry. */
  dark: ThemeVariant
}

export interface ResolvedSyntaxColors {
  keyword: string
  comment: string
  string: string
  number: string
  bool: string
  variable: string
  function: string
  type: string
  property: string
  operator: string
  punctuation: string
  tag: string
  attributeName: string
  attributeValue: string
  heading: string
  link: string
}

export const COLOR_THEME_CHANGED_EVENT = 'termul:color-theme-changed'

export interface ColorThemeChangedDetail {
  themeId: string
  syntax: ResolvedSyntaxColors
}
