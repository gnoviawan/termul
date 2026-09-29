import type { ITheme } from '@xterm/xterm'
import { forEachTerminal } from '@/utils/terminal-registry'
import { applyThemeToTerminal } from './apply-theme-to-terminal'
import {
  BUNDLED_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition
} from './bundled-themes'
import {
  contrastRatio,
  darkenHex,
  ensureContrast,
  hexToOklchComponents,
  lightenHex,
  mixHex,
  oklchComponentsToHex
} from './color-utils'
import { deriveSurfaces } from './derive-surfaces'
import { resolveSyntaxColors } from './resolve-syntax'
import { statusBarCssVars } from './status-bar-fills'
import {
  COLOR_THEME_CHANGED_EVENT,
  type ColorThemeChangedDetail,
  type ColorThemeDefinition,
  type ThemeAppearance,
  type ThemePalette
} from './types'

let lastAppliedThemeId = DEFAULT_COLOR_THEME_ID

export function getLastAppliedColorThemeId(): string {
  return lastAppliedThemeId
}

function applyDocumentAppearance(appearance: ThemeAppearance): void {
  const root = document.documentElement
  if (appearance === 'light') {
    root.style.colorScheme = 'light'
    root.classList.remove('dark')
  } else {
    root.style.colorScheme = 'dark'
    root.classList.add('dark')
  }
}

/** WCAG AA for body text. */
const TEXT_CONTRAST_MIN = 4.5

/**
 * Canonical "L C H" components for the chat code file-path chip (green
 * "added" color) and the glow box shadows. Emitted unchanged for every theme
 * so previously hardcoded literals keep rendering identically everywhere.
 */
const DIFF_ADDED_COMPONENTS = '0.72 0.192 149.5'
const DIFF_ADDED_FOREGROUND_LIGHT = '0.507 0.103 153'
const DIFF_ADDED_FOREGROUND_DARK = '0.786 0.138 154'
const DIFF_ADDED_BORDER_LIGHT = '0.585 0.113 153.2'
const DIFF_ADDED_BORDER_DARK = '0.69 0.135 153'
const GLOW_GREEN_COMPONENTS = '0.72 0.192 149.5'
const GLOW_BLUE_COMPONENTS = '0.625 0.187 259.7'
const GLOW_PURPLE_COMPONENTS = '0.557 0.251 301.9'

/**
 * Text-only tokens whose lightness is shifted (hue kept) until they pass AA
 * on the surfaces they usually sit on. Shared by the palette emitter and the
 * per-theme AA test so both stay in sync.
 */
export const TEXT_TOKENS = ['--muted-foreground', '--success', '--warning'] as const

/** Binary search precision: ~2^-40 of the [0,1] lightness range. */
/**
 * Mix a little brand hue into greys so neutrals are not chroma 0.
 * Four percent keeps contrast checks in range.
 */
const NEUTRAL_BRAND_TINT = 0.04

/**
 * CSS components for a text-only token, shifted in lightness (hue kept) until
 * it passes AA on both surfaces it usually sits on. The check runs on the
 * rounded "L C H" value that is actually emitted. Tokens that are also
 * solid fills (primary, accent, destructive) keep their palette value.
 *
 * Fast path: a single AA pass over both surfaces, then one verification of
 * the emitted value. An analytical lightness solve was evaluated and rejected:
 * it produced different (lower) lightness than the stepped search in 25 of 60
 * bundled-theme/token cases, which would shift rendered colors. The
 * escalating search below is therefore kept as the behavioral fallback; for
 * every bundled theme the fast path succeeds on the first target.
 */
export function readableTextComponents(color: string, card: string, secondary: string): string {
  const emittedCard = oklchComponentsToHex(hexToOklchComponents(card))
  const emittedSecondary = oklchComponentsToHex(hexToOklchComponents(secondary))
  const passesBoth = (emitted: string): boolean =>
    contrastRatio(emitted, emittedCard) >= TEXT_CONTRAST_MIN &&
    contrastRatio(emitted, emittedSecondary) >= TEXT_CONTRAST_MIN

  let components = hexToOklchComponents(color)
  for (let target = TEXT_CONTRAST_MIN; target <= 21; target += 0.05) {
    const candidate = ensureContrast(ensureContrast(color, card, target), secondary, target)
    components = hexToOklchComponents(candidate)
    if (passesBoth(oklchComponentsToHex(components))) return components
  }
  return components
}

function applyCssVariables(palette: ThemePalette, appearance: ThemeAppearance): void {
  const root = document.documentElement
  const tintedNeutral = mixHex(palette.neutral, palette.primary, NEUTRAL_BRAND_TINT)
  const tintedInk = mixHex(palette.ink, palette.primary, NEUTRAL_BRAND_TINT)
  const surfaces = deriveSurfaces({ ...palette, neutral: tintedNeutral }, appearance)
  const { card, secondary, muted, border, sidebar } = surfaces
  const readable = (color: string) => readableTextComponents(color, card, secondary)
  const readableSources: Record<(typeof TEXT_TOKENS)[number], string> = {
    '--muted-foreground': mixHex(tintedInk, tintedNeutral, 0.5),
    '--success': palette.success,
    '--warning': palette.warning
  }
  const readableTokens = Object.fromEntries(
    TEXT_TOKENS.map((token) => [token, readable(readableSources[token])])
  )
  const primaryForeground =
    appearance === 'light'
      ? hexToOklchComponents(lightenHex(palette.primary, 0.98))
      : hexToOklchComponents(lightenHex(palette.primary, 0.95))
  const accentForeground =
    appearance === 'light'
      ? hexToOklchComponents(lightenHex(palette.accent, 0.98))
      : hexToOklchComponents(lightenHex(palette.accent, 0.95))

  const vars: Record<string, string> = {
    '--background': hexToOklchComponents(tintedNeutral),
    '--foreground': hexToOklchComponents(tintedInk),
    '--card': hexToOklchComponents(card),
    '--card-foreground': hexToOklchComponents(tintedInk),
    '--popover': hexToOklchComponents(card),
    '--popover-foreground': hexToOklchComponents(tintedInk),
    '--primary': hexToOklchComponents(palette.primary),
    '--primary-foreground': primaryForeground,
    '--secondary': hexToOklchComponents(secondary),
    '--secondary-foreground': hexToOklchComponents(mixHex(tintedInk, tintedNeutral, 0.35)),
    '--muted': hexToOklchComponents(muted),
    '--disabled-foreground': hexToOklchComponents(mixHex(tintedInk, tintedNeutral, 0.72)),
    '--accent': hexToOklchComponents(palette.accent),
    '--accent-foreground': accentForeground,
    '--destructive': hexToOklchComponents(palette.error),
    '--destructive-foreground': hexToOklchComponents('#ffffff'),
    '--success-foreground': hexToOklchComponents('#ffffff'),
    '--connection': hexToOklchComponents(palette.info),
    '--warning-foreground': hexToOklchComponents(
      appearance === 'light' ? darkenHex(palette.warning, 0.45) : darkenHex(palette.warning, 0.55)
    ),
    ...readableTokens,
    '--diff-modified': hexToOklchComponents(palette.warning),
    '--diff-added': DIFF_ADDED_COMPONENTS,
    '--diff-added-foreground':
      appearance === 'light' ? DIFF_ADDED_FOREGROUND_LIGHT : DIFF_ADDED_FOREGROUND_DARK,
    '--diff-added-border':
      appearance === 'light' ? DIFF_ADDED_BORDER_LIGHT : DIFF_ADDED_BORDER_DARK,
    '--glow-green': GLOW_GREEN_COMPONENTS,
    '--glow-blue': GLOW_BLUE_COMPONENTS,
    '--glow-purple': GLOW_PURPLE_COMPONENTS,
    '--border': hexToOklchComponents(border),
    '--input': hexToOklchComponents(border),
    '--ring': hexToOklchComponents(palette.ink),
    '--terminal-bg': hexToOklchComponents(tintedNeutral),
    '--terminal-fg': hexToOklchComponents(tintedInk),
    '--surface-dark': hexToOklchComponents(card),
    '--surface-darker': hexToOklchComponents(palette.neutral),
    '--status-bar': hexToOklchComponents(darkenHex(palette.primary, 0.25)),
    ...statusBarCssVars(),
    '--sidebar-background': hexToOklchComponents(sidebar),
    '--sidebar-foreground': hexToOklchComponents(mixHex(tintedInk, tintedNeutral, 0.35)),
    '--sidebar-primary': hexToOklchComponents(palette.primary),
    '--sidebar-primary-foreground': hexToOklchComponents('#ffffff'),
    '--sidebar-accent': hexToOklchComponents(secondary),
    '--sidebar-accent-foreground': hexToOklchComponents(palette.ink),
    '--sidebar-border': hexToOklchComponents(border),
    '--sidebar-ring': hexToOklchComponents(palette.ink),
    '--overlay': '0 0 0',
    '--scrollbar-thumb-alpha': appearance === 'light' ? '0.75' : '0.4',
    '--scrollbar-thumb-hover-alpha': appearance === 'light' ? '0.85' : '0.65',
    '--scrollbar-thumb-active-alpha': appearance === 'light' ? '0.9' : '0.8',
    '--terminal-scrollbar-alpha': appearance === 'light' ? '0.25' : '0.15',
    '--terminal-scrollbar-hover-alpha': appearance === 'light' ? '0.4' : '0.25',
    '--search-match': hexToOklchComponents(
      appearance === 'light' ? darkenHex(muted, 0.08) : lightenHex(muted, 0.12)
    ),
    '--search-match-active': readableTokens['--warning']
  }

  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }

  applyDocumentAppearance(appearance)
}

export function paletteToXtermTheme(palette: ThemePalette, appearance: ThemeAppearance): ITheme {
  const isLight = appearance === 'light'
  return {
    background: palette.neutral,
    foreground: palette.ink,
    cursor: palette.ink,
    cursorAccent: palette.neutral,
    selectionBackground: mixHex(palette.primary, palette.neutral, isLight ? 0.25 : 0.35),
    selectionForeground: palette.ink,
    selectionInactiveBackground: isLight
      ? darkenHex(palette.neutral, 0.06)
      : lightenHex(palette.neutral, 0.12),
    black: isLight ? darkenHex(palette.neutral, 0.12) : darkenHex(palette.neutral, 0.08),
    red: palette.error,
    green: palette.success,
    yellow: palette.warning,
    blue: palette.primary,
    magenta: palette.accent,
    cyan: palette.info,
    white: palette.ink,
    brightBlack: mixHex(palette.ink, palette.neutral, 0.55),
    brightRed: isLight ? darkenHex(palette.error, 0.1) : lightenHex(palette.error, 0.15),
    brightGreen: isLight ? darkenHex(palette.success, 0.1) : lightenHex(palette.success, 0.15),
    brightYellow: isLight ? darkenHex(palette.warning, 0.1) : lightenHex(palette.warning, 0.15),
    brightBlue: isLight ? darkenHex(palette.primary, 0.1) : lightenHex(palette.primary, 0.15),
    brightMagenta: isLight ? darkenHex(palette.accent, 0.1) : lightenHex(palette.accent, 0.15),
    brightCyan: isLight ? darkenHex(palette.info, 0.1) : lightenHex(palette.info, 0.15),
    brightWhite: isLight ? darkenHex(palette.ink, 0.15) : lightenHex(palette.ink, 0.1)
  }
}

function applyTerminalThemes(xtermTheme: ITheme): void {
  forEachTerminal((terminal) => {
    applyThemeToTerminal(terminal, xtermTheme)
  })
}

function dispatchThemeChanged(detail: ColorThemeChangedDetail): void {
  window.dispatchEvent(new CustomEvent(COLOR_THEME_CHANGED_EVENT, { detail }))
}

/** Apply theme to document, terminals, and notify editors (instant, no persistence). */
export function applyColorTheme(themeId: string): void {
  const theme = getColorThemeDefinition(themeId)
  const variant = theme.dark
  const syntax = resolveSyntaxColors(theme)
  const xtermTheme = paletteToXtermTheme(variant.palette, theme.appearance)

  applyCssVariables(variant.palette, theme.appearance)
  applyTerminalThemes(xtermTheme)
  lastAppliedThemeId = theme.id
  dispatchThemeChanged({ themeId: theme.id, syntax })
}

export function getActiveTerminalTheme(): ITheme {
  const theme = getColorThemeDefinition(lastAppliedThemeId)
  return paletteToXtermTheme(theme.dark.palette, theme.appearance)
}

export function isKnownColorThemeId(themeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUNDLED_COLOR_THEMES, themeId)
}

/** @internal for tests */
export function resolveThemeForTest(theme: ColorThemeDefinition): {
  syntax: ReturnType<typeof resolveSyntaxColors>
  xterm: ITheme
} {
  return {
    syntax: resolveSyntaxColors(theme),
    xterm: paletteToXtermTheme(theme.dark.palette, theme.appearance)
  }
}
