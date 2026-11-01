/**
 * The bundled faces. CSS in index.css and tailwind.config.ts must use these
 * same family names. Generic fallbacks cover glyphs the files lack (CJK);
 * "Termul Symbols" covers the private-use icons Paper Mono has no glyphs for
 * (Nerd Font / Powerline / Font Awesome). They are not a second design font.
 */
export const SANS_FONT_FAMILY = ['"Inter Variable"', 'sans-serif'] as const
export const MONO_FONT_FAMILY = ['"Paper Mono"', '"Termul Symbols"', 'monospace'] as const

export const SANS_STACK = SANS_FONT_FAMILY.join(', ')
export const MONO_STACK = MONO_FONT_FAMILY.join(', ')

/** Family name of the symbol fallback face. */
export const SYMBOLS_FONT_FAMILY = MONO_FONT_FAMILY[1]
