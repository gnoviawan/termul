import type { ThemeComponentTokens } from './component-tokens'

/**
 * Termul brand blue, from Interfere's blue scale (Radix blue). Light and Dark
 * share the solid fill and its hover/pressed steps so buttons read the same in
 * both themes; only the text/link blue changes per appearance.
 */
export const TERMUL_BLUE = {
  /** blue-9. Switch on track. White text fails here (3.26:1), so fills skip it. */
  solid: '#0090ff',
  /** blue-10. Switch on hover. */
  solidHover: '#0588f0',
  /** blue-11. Solid fill with white text (4.77:1) and the Light link color. */
  fill: '#0d74ce',
  /** blue-11 mixed 15% toward blue-12 (#113264). White text 5.49:1. */
  fillHover: '#0e6abe',
  /** blue-11 mixed 30% toward blue-12. White text 6.36:1. */
  fillPressed: '#0e60ae',
  /** Dark blue-10. Link and text blue on the dark canvas (7.14:1 on #08090a). */
  darkText: '#3b9eff'
} as const

const SHARED_BRAND_TOKENS = {
  '--primary-fill-hover': TERMUL_BLUE.fillHover,
  '--primary-fill-active': TERMUL_BLUE.fillPressed,
  '--switch-track-on': TERMUL_BLUE.solid,
  '--switch-track-on-hover': TERMUL_BLUE.solidHover,
  '--switch-track-on-active': TERMUL_BLUE.fill,
  '--switch-thumb-on': '#ffffff',
  '--switch-thumb-off': '#ffffff',
  '--switch-disabled-opacity': '1',
  // Accent foreground is white on the brand fill, so it cannot sit on the
  // grey hover wash. Ink keeps ghost/outline labels readable.
  '--ghost-hover-foreground': 'oklch(var(--foreground))'
} as const satisfies ThemeComponentTokens

/** Interfere s-default. One hairline plus a short drop. */
const LIGHT_EMBOSS = '0 0 0 0.5px #0000000f, 0 1px 1px -1px #0000001a, 0 1px 2px 0 #0000000d'
/** Interfere dark s-default. Dark surfaces separate by a white hairline, not a drop. */
const DARK_EMBOSS = 'inset 0 0 0 0.5px #ffffff12'

/** Light: gray-a3/a4/a5 off track, white thumb with a hairline so it reads on grey. */
export const TERMUL_LIGHT_BRAND_TOKENS: ThemeComponentTokens = {
  ...SHARED_BRAND_TOKENS,
  '--shadow-emboss': LIGHT_EMBOSS,
  '--shadow-emboss-hover': LIGHT_EMBOSS,
  '--switch-track-off': '#0000000f',
  '--switch-track-off-hover': '#00000017',
  '--switch-track-off-active': '#0000001f',
  '--switch-track-on-disabled': '#0000000f',
  '--switch-track-off-disabled': '#0000000f',
  '--switch-thumb-on-disabled': '#00000044',
  '--switch-thumb-off-disabled': '#00000044',
  '--switch-thumb-shadow': '0 0 0 0.5px #00000026, 0 1px 2px #0000001a'
}

/** Dark: white-a3/a4/a5 off track; the white thumb needs no shadow. */
export const TERMUL_DARK_BRAND_TOKENS: ThemeComponentTokens = {
  ...SHARED_BRAND_TOKENS,
  '--shadow-emboss': DARK_EMBOSS,
  '--shadow-emboss-hover': DARK_EMBOSS,
  '--switch-track-off': '#ffffff12',
  '--switch-track-off-hover': '#ffffff1b',
  '--switch-track-off-active': '#ffffff22',
  '--switch-track-on-disabled': '#ffffff09',
  '--switch-track-off-disabled': '#ffffff09',
  '--switch-thumb-on-disabled': '#ffffff55',
  '--switch-thumb-off-disabled': '#ffffff55',
  '--switch-thumb-shadow': 'none'
}
