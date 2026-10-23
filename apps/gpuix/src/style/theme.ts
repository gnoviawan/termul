import { BUNDLED_COLOR_THEMES } from '@/lib/themes/bundled-themes'
import { resolveThemeTokens } from '@/lib/themes/resolve-theme-tokens'
import type { ThemeAppearance } from '@/lib/themes/types'
import { type CssVars, formatColor, parseColor, parseLength, type Rgba } from './css-value'
import { ROOT_CSS_DEFAULTS, TAILWIND_COLOR_VARS } from './generated/tailwind-colors'

/** One bundled theme resolved to the concrete values tw() paints with. */
export interface TwTheme {
  id: string
  appearance: ThemeAppearance
  /** Termul light: shadow-* utilities paint nothing except on buttons. */
  flatElevation: boolean
  /** The document's custom properties: index.css `:root`, then applyColorTheme's writes. */
  vars: CssVars
  /** Tailwind colour name (`primary`, `sidebar-foreground`, `row-hover`) -> colour. */
  colors: Readonly<Record<string, Rgba>>
  /** `--radius` in px. */
  radius: number
}

export const THEME_IDS: readonly string[] = Object.keys(BUNDLED_COLOR_THEMES)

/** Light themes darken the Rail keycap (index.css `:root:not(.dark)`). */
const LIGHT_ROOT_OVERRIDES: Record<string, string> = {
  '--rail-keycap': 'color-mix(in oklab, oklch(var(--muted)), oklch(var(--foreground)) 6%)'
}

function colorForVar(ref: string, vars: CssVars): Rgba {
  if (ref.startsWith('var:')) return parseColor(`var(${ref.slice(4)})`, vars)
  return parseColor(`oklch(${vars[ref]})`, vars)
}

const cache = new Map<string, TwTheme>()

export function resolveTwTheme(themeId: string): TwTheme {
  const cached = cache.get(themeId)
  if (cached) return cached
  const tokens = resolveThemeTokens(themeId)
  const vars: CssVars = {
    ...ROOT_CSS_DEFAULTS,
    ...(tokens.appearance === 'light' ? LIGHT_ROOT_OVERRIDES : {}),
    ...tokens.vars
  }
  const colors = Object.fromEntries(
    Object.entries(TAILWIND_COLOR_VARS).map(([name, ref]) => [name, colorForVar(ref, vars)])
  )
  const theme: TwTheme = {
    id: tokens.themeId,
    appearance: tokens.appearance,
    flatElevation: tokens.flatElevation,
    vars,
    colors,
    radius: parseLength(vars['--radius'], vars)
  }
  cache.set(themeId, theme)
  return theme
}

/** Every Tailwind colour of a theme as `#rrggbb[aa]`, for snapshots and tools. */
export function themeColorTable(theme: TwTheme): Record<string, string> {
  return Object.fromEntries(Object.entries(theme.colors).map(([name, c]) => [name, formatColor(c)]))
}
