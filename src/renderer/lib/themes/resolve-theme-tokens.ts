import { getColorThemeDefinition } from './bundled-themes'
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
import { fillInkComponents, solidFillComponents } from './solid-fills'
import { statusBarCssVars } from './status-bar-fills'
import { surfacesFromChrome } from './termul-dark-chrome'
import type { ThemeAppearance, ThemeChrome, ThemePalette } from './types'

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
/** Keep light canvases slightly below pure white to reduce glare. */
export const LIGHT_CANVAS_DARKEN = 0.025

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

interface EmittedSurface {
  hex: string
  components: string
  emittedHex: string
}

/** Round-trip a hex through the CSS "L C H" form so paint matches the token. */
export function emittedSurface(hex: string): EmittedSurface {
  const components = hexToOklchComponents(hex)
  return { hex, components, emittedHex: oklchComponentsToHex(components) }
}

/** Mix once, then the CSS "L C H" string and the hex CSS actually paints. */
export function brandTintedNeutral(palette: ThemePalette): EmittedSurface {
  return emittedSurface(mixHex(palette.neutral, palette.primary, NEUTRAL_BRAND_TINT))
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

/**
 * Every CSS custom property a theme writes, as "L C H" components (or a bare
 * number for alpha tokens). Pure: `applyColorTheme` writes these to the
 * document, the GPUIX client resolves them to concrete colours.
 */
export interface ResolvedThemeTokens {
  themeId: string
  appearance: ThemeAppearance
  flatElevation: boolean
  vars: Record<string, string>
}

export function resolveThemeTokens(themeId: string): ResolvedThemeTokens {
  const theme = getColorThemeDefinition(themeId)
  const { palette, chrome } = theme.dark
  return {
    themeId: theme.id,
    appearance: theme.appearance,
    flatElevation: chrome?.flatElevation === true,
    vars: resolveCssVariables(palette, theme.appearance, chrome)
  }
}

function resolveCssVariables(
  palette: ThemePalette,
  appearance: ThemeAppearance,
  chrome?: ThemeChrome
): Record<string, string> {
  const baseNeutralSurface = chrome
    ? emittedSurface(chrome.background)
    : brandTintedNeutral(palette)
  const tintedNeutralSurface =
    appearance === 'light'
      ? emittedSurface(darkenHex(baseNeutralSurface.hex, LIGHT_CANVAS_DARKEN))
      : baseNeutralSurface
  const tintedNeutral = chrome ? chrome.background : tintedNeutralSurface.hex
  const foregroundHex = chrome
    ? chrome.foreground
    : mixHex(palette.ink, palette.primary, NEUTRAL_BRAND_TINT)
  const surfaces = chrome
    ? surfacesFromChrome(chrome)
    : deriveSurfaces({ ...palette, neutral: tintedNeutral }, appearance)
  const { card, secondary, muted, border, sidebar } = surfaces
  const popoverHex = chrome?.elevated ?? card
  const surfaceDarkerHex = chrome?.background ?? palette.neutral
  const ringHex = chrome?.foreground ?? palette.ink
  const readable = (color: string) => readableTextComponents(color, card, secondary)
  const readableSources: Record<(typeof TEXT_TOKENS)[number], string> = {
    '--muted-foreground': chrome
      ? chrome.mutedForeground
      : mixHex(foregroundHex, tintedNeutral, 0.5),
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
  const secondaryForeground = chrome
    ? readable(chrome.secondaryForeground)
    : hexToOklchComponents(mixHex(foregroundHex, tintedNeutral, 0.35))
  const foregroundComponents = hexToOklchComponents(foregroundHex)

  return {
    '--background': tintedNeutralSurface.components,
    '--foreground': foregroundComponents,
    '--card': hexToOklchComponents(card),
    '--card-foreground': foregroundComponents,
    '--popover': hexToOklchComponents(popoverHex),
    '--popover-foreground': foregroundComponents,
    '--primary-fill': primaryFill,
    '--primary-foreground': primaryForeground,
    '--secondary': hexToOklchComponents(secondary),
    '--secondary-foreground': secondaryForeground,
    '--muted': hexToOklchComponents(muted),
    '--disabled-foreground': readableUiComponents(mixHex(foregroundHex, tintedNeutral, 0.45), [
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
    '--field-border': readableUiComponents(border, [
      card,
      tintedNeutralSurface.emittedHex,
      popoverHex
    ]),
    '--ring': hexToOklchComponents(ringHex),
    '--terminal-bg': tintedNeutralSurface.components,
    '--terminal-fg': foregroundComponents,
    '--surface-dark': hexToOklchComponents(card),
    '--surface-darker': hexToOklchComponents(surfaceDarkerHex),
    '--status-bar': hexToOklchComponents(darkenHex(palette.primary, 0.25)),
    ...statusBarCssVars(),
    '--sidebar-background': hexToOklchComponents(sidebar),
    '--sidebar-foreground': secondaryForeground,
    '--sidebar-primary': primaryFill,
    '--sidebar-primary-foreground': '1 0 0',
    '--sidebar-accent': hexToOklchComponents(secondary),
    '--sidebar-accent-foreground': hexToOklchComponents(ringHex),
    '--sidebar-border': hexToOklchComponents(border),
    '--sidebar-ring': hexToOklchComponents(ringHex),
    '--overlay': '0 0 0',
    ...SCROLLBAR_ALPHA[appearance],
    '--search-match': hexToOklchComponents(
      appearance === 'light' ? darkenHex(muted, 0.08) : lightenHex(muted, 0.12)
    ),
    '--search-match-active': readableTokens['--warning']
  }
}
