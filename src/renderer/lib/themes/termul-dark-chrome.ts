import { hexToOklch, oklchToHex } from './color-utils'
import type { DerivedSurfaces } from './derive-surfaces'
import type { ThemeChrome } from './types'

/** Linear void. Page canvas. */
const VOID = '#08090a'
/** Linear carbon. Raised panels. */
const CARBON = '#0f1011'
/** Linear obsidian. Menus and hover. */
const OBSIDIAN = '#161718'
/**
 * Linear graphite. Its hue sits near 268, about 22° off void, so the border
 * keeps this lightness and void's hue instead of the raw hex.
 */
const GRAPHITE = '#23252a'
/** Linear bone. Primary copy. */
const BONE = '#e5e5e6'
/** Linear mist. Secondary labels. */
const MIST = '#d0d6e0'
/** Linear fog. Muted copy. */
const FOG = '#8a8f98'

/** Same hue and chroma as `sourceHex`, at `lightness`. */
function holdHue(sourceHex: string, lightness: number): string {
  const source = hexToOklch(sourceHex)
  return oklchToHex({ l: lightness, c: source.c, h: source.h })
}

function termulDarkChrome(): ThemeChrome {
  const obsidianL = hexToOklch(OBSIDIAN).l
  const graphiteL = hexToOklch(GRAPHITE).l
  return {
    background: VOID,
    card: CARBON,
    elevated: OBSIDIAN,
    muted: holdHue(VOID, (obsidianL + graphiteL) / 2),
    border: holdHue(VOID, graphiteL),
    foreground: BONE,
    secondaryForeground: MIST,
    mutedForeground: FOG
  }
}

/** Neutral ramp for the default Termul dark theme. */
export const TERMUL_DARK_CHROME: ThemeChrome = termulDarkChrome()

/** Map the explicit ramp onto the shared surface slots. */
export function surfacesFromChrome(chrome: ThemeChrome): DerivedSurfaces {
  return {
    card: chrome.card,
    secondary: chrome.elevated,
    muted: chrome.muted,
    border: chrome.border,
    sidebar: chrome.elevated
  }
}
