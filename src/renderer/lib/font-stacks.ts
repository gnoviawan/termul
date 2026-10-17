/**
 * The two bundled faces. CSS in index.css and tailwind.config.ts must use
 * these same family names. Generic fallbacks cover glyphs the files lack
 * (CJK, Powerline icons). They are not a second design font.
 */
export const SANS_FONT_FAMILY = ['"Inter Variable"', 'sans-serif'] as const
export const MONO_FONT_FAMILY = ['"Paper Mono"', 'monospace'] as const

export const SANS_STACK = SANS_FONT_FAMILY.join(', ')
export const MONO_STACK = MONO_FONT_FAMILY.join(', ')
