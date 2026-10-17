import type { ThemeSyntaxOverrides } from './types'

/**
 * Termul dark syntax, matched to the Cursor editor.
 * Colors are the peak values sampled from that theme.
 *
 * Teal is a keyword. Peach is a declared function or type name.
 * Blue is a name being read. Lavender is a name being declared.
 * Pink is a string. Comments stay neutral gray.
 *
 * Each role clears WCAG AA (4.5:1) on Void `#08090a` and Carbon `#0f1011`.
 * Neighboring roles stay at least 15° apart in OKLCH hue.
 */
export const TERMUL_DARK_SYNTAX: ThemeSyntaxOverrides = {
  'syntax-comment': '#a3a3a3',
  'syntax-keyword': '#95d0cd',
  'syntax-string': '#d898d8',
  'syntax-type': '#e6b387',
  'syntax-constant': '#d5cf77',
  'syntax-primitive': '#95d0cd',
  'syntax-variable': '#94c2fa',
  'syntax-definition': '#a9a1f4',
  'syntax-function': '#e6b387',
  'syntax-operator': '#d6d6dd',
  'syntax-punctuation': '#d6d6dd',
  'syntax-tag': '#a9a1f4',
  'syntax-attribute': '#a9a1f4'
}

/**
 * Same hues as the dark palette, darkened for paper.
 * Each role clears WCAG AA on `#ffffff`.
 */
export const TERMUL_LIGHT_SYNTAX: ThemeSyntaxOverrides = {
  'syntax-comment': '#5a5a5a',
  'syntax-keyword': '#3e7875',
  'syntax-string': '#945995',
  'syntax-type': '#94653b',
  'syntax-constant': '#77700a',
  'syntax-primitive': '#3e7875',
  'syntax-variable': '#4570a3',
  'syntax-definition': '#6e64b2',
  'syntax-function': '#94653b',
  'syntax-operator': '#3f4248',
  'syntax-punctuation': '#3f4248',
  'syntax-tag': '#6e64b2',
  'syntax-attribute': '#6e64b2'
}
