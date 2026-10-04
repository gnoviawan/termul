import { mixHex } from './color-utils'
import type { ThemeChrome } from './types'

/** ChatGPT pure white. Main canvas and elevated panels. */
const PAPER = '#ffffff'
/** ChatGPT sidebar mist. Left rail. */
const MIST = '#f9f9f9'
/** ChatGPT graphite ink. Primary copy. Not pure black. */
const INK = '#0d0d0d'
/** ChatGPT mid ash. Secondary labels. */
const ASH = '#5d5d5d'
/** ChatGPT hollow. Muted copy. The AA solver may darken this. */
const HOLLOW = '#8f8f8f'
/** `#0000001a` on white. Opaque hairline. */
const HAIRLINE_ALPHA = 26 / 255
/** `#0000000d` on white. Hover veil. */
const HOVER_ALPHA = 13 / 255

function termulLightChrome(): ThemeChrome {
  return {
    background: PAPER,
    card: PAPER,
    elevated: PAPER,
    secondary: mixHex(PAPER, '#000000', HOVER_ALPHA),
    sidebar: MIST,
    muted: MIST,
    border: mixHex(PAPER, '#000000', HAIRLINE_ALPHA),
    foreground: INK,
    secondaryForeground: ASH,
    mutedForeground: HOLLOW,
    flatElevation: true
  }
}

/** Paper ramp for the default Termul light theme. */
export const TERMUL_LIGHT_CHROME: ThemeChrome = termulLightChrome()
