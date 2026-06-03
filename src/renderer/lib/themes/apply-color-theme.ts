import type { ITheme } from '@xterm/xterm'
import { forEachTerminal } from '@/utils/terminal-registry'
import {
  BUNDLED_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition
} from './bundled-themes'
import { darkenHex, hexToHslComponents, lightenHex, mixHex } from './color-utils'
import { deriveSurfaces } from './derive-surfaces'
import { resolveSyntaxColors } from './resolve-syntax'
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

function applyCssVariables(palette: ThemePalette, appearance: ThemeAppearance): void {
  const root = document.documentElement
  const surfaces = deriveSurfaces(palette, appearance)
  const { card, secondary, muted, border, sidebar } = surfaces
  const primaryForeground =
    appearance === 'light'
      ? hexToHslComponents(lightenHex(palette.primary, 0.98))
      : hexToHslComponents(lightenHex(palette.primary, 0.95))
  const accentForeground =
    appearance === 'light'
      ? hexToHslComponents(lightenHex(palette.accent, 0.98))
      : hexToHslComponents(lightenHex(palette.accent, 0.95))

  const vars: Record<string, string> = {
    '--background': hexToHslComponents(palette.neutral),
    '--foreground': hexToHslComponents(palette.ink),
    '--card': hexToHslComponents(card),
    '--card-foreground': hexToHslComponents(palette.ink),
    '--popover': hexToHslComponents(card),
    '--popover-foreground': hexToHslComponents(palette.ink),
    '--primary': hexToHslComponents(palette.primary),
    '--primary-foreground': primaryForeground,
    '--secondary': hexToHslComponents(secondary),
    '--secondary-foreground': hexToHslComponents(mixHex(palette.ink, palette.neutral, 0.35)),
    '--muted': hexToHslComponents(muted),
    '--muted-foreground': hexToHslComponents(mixHex(palette.ink, palette.neutral, 0.5)),
    '--accent': hexToHslComponents(palette.accent),
    '--accent-foreground': accentForeground,
    '--destructive': hexToHslComponents(palette.error),
    '--destructive-foreground': hexToHslComponents('#ffffff'),
    '--border': hexToHslComponents(border),
    '--input': hexToHslComponents(border),
    '--ring': hexToHslComponents(palette.primary),
    '--terminal-bg': hexToHslComponents(palette.neutral),
    '--terminal-fg': hexToHslComponents(palette.ink),
    '--surface-dark': hexToHslComponents(card),
    '--surface-darker': hexToHslComponents(palette.neutral),
    '--status-bar': hexToHslComponents(darkenHex(palette.primary, 0.25)),
    '--sidebar-background': hexToHslComponents(sidebar),
    '--sidebar-foreground': hexToHslComponents(mixHex(palette.ink, palette.neutral, 0.35)),
    '--sidebar-primary': hexToHslComponents(palette.primary),
    '--sidebar-primary-foreground': hexToHslComponents('#ffffff'),
    '--sidebar-accent': hexToHslComponents(secondary),
    '--sidebar-accent-foreground': hexToHslComponents(palette.ink),
    '--sidebar-border': hexToHslComponents(border),
    '--sidebar-ring': hexToHslComponents(palette.primary)
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
    terminal.options.theme = xtermTheme
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
