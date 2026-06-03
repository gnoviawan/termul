import type { ITheme } from '@xterm/xterm'
import { forEachTerminal } from '@/utils/terminal-registry'
import {
  BUNDLED_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  getColorThemeDefinition
} from './bundled-themes'
import { darkenHex, hexToHslComponents, lightenHex, mixHex } from './color-utils'
import { resolveSyntaxColors } from './resolve-syntax'
import {
  COLOR_THEME_CHANGED_EVENT,
  type ColorThemeChangedDetail,
  type ColorThemeDefinition,
  type ThemePalette
} from './types'

let lastAppliedThemeId = DEFAULT_COLOR_THEME_ID

export function getLastAppliedColorThemeId(): string {
  return lastAppliedThemeId
}

function applyCssVariables(palette: ThemePalette): void {
  const root = document.documentElement
  const card = lightenHex(palette.neutral, 0.06)
  const secondary = lightenHex(palette.neutral, 0.08)
  const muted = lightenHex(palette.neutral, 0.11)
  const border = lightenHex(palette.neutral, 0.14)
  const sidebar = mixHex(palette.neutral, '#000000', 0.04)

  const vars: Record<string, string> = {
    '--background': hexToHslComponents(palette.neutral),
    '--foreground': hexToHslComponents(palette.ink),
    '--card': hexToHslComponents(card),
    '--card-foreground': hexToHslComponents(palette.ink),
    '--popover': hexToHslComponents(card),
    '--popover-foreground': hexToHslComponents(palette.ink),
    '--primary': hexToHslComponents(palette.primary),
    '--primary-foreground': hexToHslComponents(lightenHex(palette.primary, 0.95)),
    '--secondary': hexToHslComponents(secondary),
    '--secondary-foreground': hexToHslComponents(mixHex(palette.ink, palette.neutral, 0.35)),
    '--muted': hexToHslComponents(muted),
    '--muted-foreground': hexToHslComponents(mixHex(palette.ink, palette.neutral, 0.5)),
    '--accent': hexToHslComponents(palette.primary),
    '--accent-foreground': hexToHslComponents(lightenHex(palette.primary, 0.95)),
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

  root.style.colorScheme = 'dark'
  root.classList.add('dark')
}

export function paletteToXtermTheme(palette: ThemePalette): ITheme {
  return {
    background: palette.neutral,
    foreground: palette.ink,
    cursor: palette.ink,
    cursorAccent: palette.neutral,
    selectionBackground: mixHex(palette.primary, palette.neutral, 0.35),
    selectionForeground: palette.ink,
    selectionInactiveBackground: lightenHex(palette.neutral, 0.12),
    black: darkenHex(palette.neutral, 0.08),
    red: palette.error,
    green: palette.success,
    yellow: palette.warning,
    blue: palette.primary,
    magenta: palette.accent,
    cyan: palette.info,
    white: palette.ink,
    brightBlack: mixHex(palette.ink, palette.neutral, 0.55),
    brightRed: lightenHex(palette.error, 0.15),
    brightGreen: lightenHex(palette.success, 0.15),
    brightYellow: lightenHex(palette.warning, 0.15),
    brightBlue: lightenHex(palette.primary, 0.15),
    brightMagenta: lightenHex(palette.accent, 0.15),
    brightCyan: lightenHex(palette.info, 0.15),
    brightWhite: lightenHex(palette.ink, 0.1)
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
  const xtermTheme = paletteToXtermTheme(variant.palette)

  applyCssVariables(variant.palette)
  applyTerminalThemes(xtermTheme)
  lastAppliedThemeId = theme.id
  dispatchThemeChanged({ themeId: theme.id, syntax })
}

export function getActiveTerminalTheme(): ITheme {
  const theme = getColorThemeDefinition(lastAppliedThemeId)
  return paletteToXtermTheme(theme.dark.palette)
}

export function isKnownColorThemeId(themeId: string): boolean {
  return themeId in BUNDLED_COLOR_THEMES
}

/** @internal for tests */
export function resolveThemeForTest(theme: ColorThemeDefinition): {
  syntax: ReturnType<typeof resolveSyntaxColors>
  xterm: ITheme
} {
  return {
    syntax: resolveSyntaxColors(theme),
    xterm: paletteToXtermTheme(theme.dark.palette)
  }
}
