import type { ThemeSyntaxOverrides } from './types'

/**
 * Termul dark syntax. High, even lightness and separate hues.
 * Comments stay neutral gray. Identifiers stay the foreground bone.
 *
 * Tuned in OKLCH against Void `#08090a` and Carbon `#0f1011`.
 * Each colored role clears WCAG AA (4.5:1) on both surfaces.
 */
export const TERMUL_DARK_SYNTAX: ThemeSyntaxOverrides = {
  'syntax-comment': '#999fa8',
  'syntax-keyword': '#d5b2ff',
  'syntax-string': '#7fe4a5',
  'syntax-type': '#72dee4',
  'syntax-constant': '#f2d76c',
  'syntax-primitive': '#d5b2ff',
  'syntax-function': '#9dc7fe',
  'syntax-operator': '#a7abb1',
  'syntax-punctuation': '#a7abb1',
  'syntax-tag': '#e5e5e6',
  'syntax-attribute': '#e5e5e6'
}

/**
 * Termul light syntax. Same roles as the dark palette, darkened for paper.
 * Identifiers stay the graphite ink. Comments stay gray, not green.
 */
export const TERMUL_LIGHT_SYNTAX: ThemeSyntaxOverrides = {
  'syntax-comment': '#54585f',
  'syntax-keyword': '#753ba8',
  'syntax-string': '#036a34',
  'syntax-type': '#03758e',
  'syntax-constant': '#8a5601',
  'syntax-primitive': '#753ba8',
  'syntax-function': '#0256a9',
  'syntax-operator': '#45484d',
  'syntax-punctuation': '#45484d',
  'syntax-tag': '#0d0d0d',
  'syntax-attribute': '#0d0d0d'
}
