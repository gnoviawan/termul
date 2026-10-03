import type { ITheme } from '@xterm/xterm'
import { forEachTerminal } from '@/utils/terminal-registry'
import { applyThemeToTerminal } from './apply-theme-to-terminal'
import {
  BUNDLED_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition
} from './bundled-themes'
import {
  darkenHex,
  hexToOklchComponents,
  lightenHex,
  mixHex,
  oklchComponentsToHex,
  solveEmittedContrast,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN
} from './color-utils'
import { deriveSurfaces } from './derive-surfaces'
import { resolveSyntaxColors } from './resolve-syntax'
import { fillInkComponents, solidFillComponents } from './solid-fills'
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
 * per-theme AA test so both stay in sync. Solid buttons use `--*-fill`.
 * `--accent` stays a selected-row fill (`bg-accent` + `text-accent-foreground`).
 */
export const TEXT_TOKENS = [
  '--muted-foreground',
  '--primary',
  '--success',
  '--warning',
  '--destructive'
] as const

/**
 * Mix a little brand hue into greys so neutrals are not chroma 0.
 * Four percent keeps contrast checks in range.
 */
const NEUTRAL_BRAND_TINT = 0.04

const SCROLLBAR_ALPHA = {
  light: {
    '--scrollbar-thumb-alpha': '0.75',
    '--scrollbar-thumb-hover-alpha': '0.85',
    '--scrollbar-thumb-active-alpha': '0.9',
    '--terminal-scrollbar-alpha': '0.25',
    '--terminal-scrollbar-hover-alpha': '0.4'
  },
  dark: {
    '--scrollbar-thumb-alpha': '0.4',
    '--scrollbar-thumb-hover-alpha': '0.65',
    '--scrollbar-thumb-active-alpha': '0.8',
    '--terminal-scrollbar-alpha': '0.15',
    '--terminal-scrollbar-hover-alpha': '0.25'
  }
} as const

/** Mix once, then the CSS "L C H" string and the hex CSS actually paints. */
function brandTintedNeutral(palette: ThemePalette): {
  hex: string
  components: string
  emittedHex: string
} {
  const hex = mixHex(palette.neutral, palette.primary, NEUTRAL_BRAND_TINT)
  const components = hexToOklchComponents(hex)
  return { hex, components, emittedHex: oklchComponentsToHex(components) }
}

/** Same hex CSS writes to `--background` / `--terminal-bg` after the OKLCH round trip. */
export function tintedSurfaceHex(palette: ThemePalette): string {
  return brandTintedNeutral(palette).emittedHex
}

/** CSS components for a text-only token. Solid fills use `--*-fill`. */
export function readableTextComponents(color: string, card: string, secondary: string): string {
  return solveEmittedContrast(color, [card, secondary], TEXT_CONTRAST_MIN)
}

export function readableUiComponents(color: string, surfaces: string[]): string {
  return solveEmittedContrast(color, surfaces, UI_CONTRAST_MIN)
}

function applyCssVariables(palette: ThemePalette, appearance: ThemeAppearance): void {
  const root = document.documentElement
  const tintedNeutralSurface = brandTintedNeutral(palette)
  const tintedNeutral = tintedNeutralSurface.hex
  const tintedInk = mixHex(palette.ink, palette.primary, NEUTRAL_BRAND_TINT)
  const surfaces = deriveSurfaces({ ...palette, neutral: tintedNeutral }, appearance)
  const { card, secondary, muted, border, sidebar } = surfaces
  const readable = (color: string) => readableTextComponents(color, card, secondary)
  const readableSources: Record<(typeof TEXT_TOKENS)[number], string> = {
    '--muted-foreground': mixHex(tintedInk, tintedNeutral, 0.5),
    '--primary': palette.primary,
    '--success': palette.success,
    '--warning': palette.warning,
    '--destructive': palette.error
  }
  const readableTokens = Object.fromEntries(
    TEXT_TOKENS.map((token) => [token, readable(readableSources[token])])
  )
  const warningFillHex = oklchComponentsToHex(readableTokens['--warning'])
  const primaryFill = solidFillComponents(palette.primary)
  const accentFill = solidFillComponents(palette.accent)
  const successFill = solidFillComponents(palette.success)
  const destructiveFill = solidFillComponents(palette.error)
  const primaryForeground =
    appearance === 'light'
      ? hexToOklchComponents(lightenHex(palette.primary, 0.98))
      : hexToOklchComponents(lightenHex(palette.primary, 0.95))
  const accentForeground =
    appearance === 'light'
      ? hexToOklchComponents(lightenHex(palette.accent, 0.98))
      : hexToOklchComponents(lightenHex(palette.accent, 0.95))

  const vars: Record<string, string> = {
    '--background': tintedNeutralSurface.components,
    '--foreground': hexToOklchComponents(tintedInk),
    '--card': hexToOklchComponents(card),
    '--card-foreground': hexToOklchComponents(tintedInk),
    '--popover': hexToOklchComponents(card),
    '--popover-foreground': hexToOklchComponents(tintedInk),
    '--primary-fill': primaryFill,
    '--primary-foreground': primaryForeground,
    '--secondary': hexToOklchComponents(secondary),
    '--secondary-foreground': hexToOklchComponents(mixHex(tintedInk, tintedNeutral, 0.35)),
    '--muted': hexToOklchComponents(muted),
    '--disabled-foreground': readableUiComponents(mixHex(tintedInk, tintedNeutral, 0.45), [
      muted,
      card,
      secondary
    ]),
    '--accent': accentFill,
    '--accent-foreground': accentForeground,
    '--destructive': readableTokens['--destructive'],
    '--destructive-fill': destructiveFill,
    '--destructive-foreground': '1 0 0',
    '--success-foreground': '1 0 0',
    '--success-fill': successFill,
    '--connection': hexToOklchComponents(palette.info),
    '--warning-foreground': fillInkComponents(warningFillHex),
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
    '--terminal-bg': tintedNeutralSurface.components,
    '--terminal-fg': hexToOklchComponents(tintedInk),
    '--surface-dark': hexToOklchComponents(card),
    '--surface-darker': hexToOklchComponents(palette.neutral),
    '--status-bar': hexToOklchComponents(darkenHex(palette.primary, 0.25)),
    ...statusBarCssVars(),
    '--sidebar-background': hexToOklchComponents(sidebar),
    '--sidebar-foreground': hexToOklchComponents(mixHex(tintedInk, tintedNeutral, 0.35)),
    '--sidebar-primary': primaryFill,
    '--sidebar-primary-foreground': '1 0 0',
    '--sidebar-accent': hexToOklchComponents(secondary),
    '--sidebar-accent-foreground': hexToOklchComponents(palette.ink),
    '--sidebar-border': hexToOklchComponents(border),
    '--sidebar-ring': hexToOklchComponents(palette.ink),
    '--overlay': '0 0 0',
    ...SCROLLBAR_ALPHA[appearance],
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
  const surface = brandTintedNeutral(palette).emittedHex
  return {
    background: surface,
    foreground: palette.ink,
    cursor: palette.ink,
    cursorAccent: surface,
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

const THEME_TRANSITION_STYLE_ID = 'termul-disable-theme-transitions'

/**
 * Theme swaps restyle fill and shadow on every primary button at once.
 * Hold transitions off until the new colors have painted.
 */
function suppressTransitionsForThemeSwap(): void {
  document.getElementById(THEME_TRANSITION_STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = THEME_TRANSITION_STYLE_ID
  style.append(document.createTextNode('*,*::before,*::after{transition:none !important}'))
  document.head.append(style)
  void document.body.offsetHeight
  requestAnimationFrame(() => {
    requestAnimationFrame(() => style.remove())
  })
}

/** Apply theme to document, terminals, and notify editors (instant, no persistence). */
export function applyColorTheme(themeId: string): void {
  const theme = getColorThemeDefinition(themeId)
  const variant = theme.dark
  const syntax = resolveSyntaxColors(theme)
  const xtermTheme = paletteToXtermTheme(variant.palette, theme.appearance)

  suppressTransitionsForThemeSwap()
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
