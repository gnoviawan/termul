import type { ITheme } from '@xterm/xterm'
import { forEachTerminal } from '@/utils/terminal-registry'
import { applyThemeToTerminal } from './apply-theme-to-terminal'
import {
  BUNDLED_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition
} from './bundled-themes'
import { darkenHex, lightenHex, mixHex } from './color-utils'
import { resolveSyntaxColors } from './resolve-syntax'
import {
  brandTintedNeutral,
  emittedSurface,
  LIGHT_CANVAS_DARKEN,
  type ResolvedThemeTokens,
  resolveThemeTokens
} from './resolve-theme-tokens'
import {
  COLOR_THEME_CHANGED_EVENT,
  type ColorThemeChangedDetail,
  type ColorThemeDefinition,
  type ThemeAppearance,
  type ThemeChrome,
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

function applyThemeTokens(tokens: ResolvedThemeTokens): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(tokens.vars)) {
    root.style.setProperty(key, value)
  }

  if (tokens.flatElevation) {
    root.dataset.flatElevation = 'true'
  } else {
    delete root.dataset.flatElevation
  }

  applyDocumentAppearance(tokens.appearance)
}

export function paletteToXtermTheme(
  palette: ThemePalette,
  appearance: ThemeAppearance,
  chrome?: ThemeChrome
): ITheme {
  const isLight = appearance === 'light'
  const baseSurface = chrome
    ? emittedSurface(chrome.background).emittedHex
    : brandTintedNeutral(palette).emittedHex
  const surface = appearance === 'light' ? darkenHex(baseSurface, LIGHT_CANVAS_DARKEN) : baseSurface
  const foreground = chrome?.foreground ?? palette.ink
  return {
    background: surface,
    foreground,
    cursor: foreground,
    cursorAccent: surface,
    selectionBackground: mixHex(palette.primary, palette.neutral, isLight ? 0.25 : 0.35),
    selectionForeground: foreground,
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
    white: foreground,
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
  const xtermTheme = paletteToXtermTheme(variant.palette, theme.appearance, variant.chrome)

  suppressTransitionsForThemeSwap()
  applyThemeTokens(resolveThemeTokens(theme.id))
  applyTerminalThemes(xtermTheme)
  lastAppliedThemeId = theme.id
  dispatchThemeChanged({ themeId: theme.id, syntax })
}

export function getActiveTerminalTheme(): ITheme {
  const theme = getColorThemeDefinition(lastAppliedThemeId)
  return paletteToXtermTheme(theme.dark.palette, theme.appearance, theme.dark.chrome)
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
    xterm: paletteToXtermTheme(theme.dark.palette, theme.appearance, theme.dark.chrome)
  }
}
