import { TERMUL_BLUE, TERMUL_LIGHT_BRAND_TOKENS } from './termul-brand'
import type { ThemeChrome } from './types'

/*
 * Interfere neutrals (Radix gray, alpha steps flattened onto the page so the
 * AA solver can read them as hex). Elevation comes from shadow, not border.
 */

/** Interfere gray-1. Page and terminal; a step off white to cut glare. */
const PAGE = '#fcfcfc'
/** Raised panels, menus and dialogs. Their shadow ring separates them. */
export const CONTAINER = '#ffffff'
/** Interfere shell, oklch(0.973 0 0). Sidebar and title bar. */
const SHELL = '#f6f6f6'
/** gray-a3 on the page. Hover wash. */
const COMPONENT = '#f0f0f0'
/** Recessed wells and code blocks. */
const RECESSED = '#f2f2f2'
/** gray-a3, black 6% on the page. Hairline. */
const BORDER = '#ededed'
/** gray-a6. Input outlines. */
const BORDER_STRONG = '#d9d9d9'
/** gray-a12. Primary copy. */
const INK = '#202020'
/** gray-a11. Secondary and muted copy: 5.92:1 on white, 5.48:1 on the shell. */
const SECONDARY_INK = '#646464'

/** Interfere s-default: 0.5px ring plus a short drop. Cards and raised controls. */
export const S_DEFAULT = '0 0 0 0.5px #0000000f, 0 1px 1px -1px #0000001a, 0 1px 2px 0 #0000000d'
/** Interfere s-large. Popovers, menus, tooltips. */
const S_LARGE =
  '0 0 0 0.5px color-mix(in oklab, #0000000f, #f0f0f0 25%), 0 2px 3px -2px #0000000f, 0 3px 12px -4px #0000001a, 0 4px 16px -8px #0000000d'
/** Interfere s-extra-large. Dialogs, sheets, the command palette. */
const S_EXTRA_LARGE = '0 0 0 0.5px #0000000f, 0 8px 40px 0 #0000000d, 0 12px 32px -16px #00000026'

function termulLightChrome(): ThemeChrome {
  return {
    background: PAGE,
    card: CONTAINER,
    elevated: CONTAINER,
    secondary: COMPONENT,
    sidebar: SHELL,
    muted: RECESSED,
    border: BORDER,
    input: BORDER_STRONG,
    foreground: INK,
    secondaryForeground: SECONDARY_INK,
    mutedForeground: SECONDARY_INK,
    brandFill: TERMUL_BLUE.fill,
    tokens: {
      ...TERMUL_LIGHT_BRAND_TOKENS,
      /** gray-a4: one step above a3 because animate-pulse dips to 50%. */
      '--skeleton': '#00000017',
      '--elevation-2xs': S_DEFAULT,
      '--elevation-xs': S_DEFAULT,
      '--elevation-sm': S_DEFAULT,
      '--elevation-md': S_LARGE,
      '--elevation-lg': S_LARGE,
      '--elevation-xl': S_EXTRA_LARGE,
      '--elevation-2xl': S_EXTRA_LARGE,
      '--elevation-pill': S_LARGE,
      '--elevation-panel': S_EXTRA_LARGE,
      '--elevation-menu': S_EXTRA_LARGE,
      /** The composer is white on the white chat card: lift it with s-default. */
      '--composer-shadow': S_DEFAULT,
      /** Prompt panels replace the composer, so they take the same lift. */
      '--prompt-panel-shadow': S_DEFAULT,
      /** Tabs and other raised items: a white container with s-default, as in Interfere. */
      '--keycap-fill': CONTAINER,
      '--keycap-shadow': S_DEFAULT,
      /** Active Rail row: a white container raised off the shell, as in Interfere. */
      '--rail-keycap-fill': CONTAINER,
      '--rail-keycap-shadow': S_DEFAULT
    }
  }
}

/** Interfere ramp for the default Termul light theme. */
export const TERMUL_LIGHT_CHROME: ThemeChrome = termulLightChrome()
