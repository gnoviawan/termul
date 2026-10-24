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

/**
 * Emboss on the primary fill: a dark outer hairline, a short drop, a white
 * top bevel and a dark bottom bevel. The bevels make the depth read on the
 * blue fill itself, so it works on both canvases. Hover lifts a little.
 */
const LIGHT_EMBOSS =
  '0 0 0 0.5px #00000033, 0 1px 2px #00000026, 0 2px 4px -1px #0000001a, inset 0 1px 0 #ffffff47, inset 0 -1px 0 #00000026'
const LIGHT_EMBOSS_HOVER =
  '0 0 0 0.5px #0000003d, 0 1px 2px #0000002e, 0 3px 6px -1px #00000024, inset 0 1px 0 #ffffff52, inset 0 -1px 0 #0000002e'
/**
 * Dark: a drop barely reads on the near-black canvas, so depth comes from a
 * brighter top bevel, a 2px bottom bevel and a faint white inner rim.
 */
const DARK_EMBOSS =
  '0 0 0 0.5px #000000, 0 1px 3px #000000b3, inset 0 0 0 0.5px #ffffff1f, inset 0 1px 0 #ffffff66, inset 0 -2px 0 #00000059'
const DARK_EMBOSS_HOVER =
  '0 0 0 0.5px #000000, 0 2px 4px #000000cc, inset 0 0 0 0.5px #ffffff29, inset 0 1px 0 #ffffff80, inset 0 -2px 0 #00000066'

/**
 * Light: gray-a9/a10/a11 off track. gray-a9 flattens to oklch(0.643 0 0) on
 * the white card, 3.32:1 against it and against the white thumb (WCAG
 * 1.4.11), and stays at or above 3.24:1 on every Light surface. Disabled
 * drops to a gray-a4 track with a grey thumb: no white thumb and no blue, so
 * it reads as off-limits, while the thumb still outlines the control.
 */
export const TERMUL_LIGHT_BRAND_TOKENS: ThemeComponentTokens = {
  ...SHARED_BRAND_TOKENS,
  '--shadow-emboss': LIGHT_EMBOSS,
  '--shadow-emboss-hover': LIGHT_EMBOSS_HOVER,
  '--switch-track-off': 'oklch(0 0 0 / 0.447)',
  '--switch-track-off-hover': 'oklch(0 0 0 / 0.486)',
  '--switch-track-off-active': 'oklch(0 0 0 / 0.608)',
  '--switch-track-on-disabled': 'oklch(0 0 0 / 0.09)',
  '--switch-track-off-disabled': 'oklch(0 0 0 / 0.09)',
  '--switch-thumb-on-disabled': 'oklch(0 0 0 / 0.267)',
  '--switch-thumb-off-disabled': 'oklch(0 0 0 / 0.267)',
  '--switch-thumb-shadow': '0 0 0 0.5px #00000026, 0 1px 2px #0000001a'
}

/** Dark: white-a3/a4/a5 off track; the white thumb needs no shadow. */
export const TERMUL_DARK_BRAND_TOKENS: ThemeComponentTokens = {
  ...SHARED_BRAND_TOKENS,
  '--shadow-emboss': DARK_EMBOSS,
  '--shadow-emboss-hover': DARK_EMBOSS_HOVER,
  '--switch-track-off': '#ffffff12',
  '--switch-track-off-hover': '#ffffff1b',
  '--switch-track-off-active': '#ffffff22',
  '--switch-track-on-disabled': '#ffffff09',
  '--switch-track-off-disabled': '#ffffff09',
  '--switch-thumb-on-disabled': '#ffffff55',
  '--switch-thumb-off-disabled': '#ffffff55',
  '--switch-thumb-shadow': 'none'
}
