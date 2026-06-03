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

export interface ColorThemeDefinition {
  id: string
  name: string
  dark: ThemeVariant
  /** Reserved for light-mode toggle (v2). */
  light?: ThemeVariant
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
