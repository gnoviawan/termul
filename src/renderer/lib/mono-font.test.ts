import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MONO_FONT_FAMILY, MONO_STACK, SYMBOLS_FONT_FAMILY } from '@/lib/font-stacks'

// The bundled symbol face is what keeps Nerd Font / Powerline icons from
// rendering as tofu. Metrics must match Paper Mono (1000 upm, 606/1000 advance,
// 955/-245 vertical) or xterm's single-cell measurement puts icons outside
// their cell.
const FONT_DIR = 'src/renderer/assets/fonts/termul-symbols'

describe('termul symbol fallback', () => {
  it('sits in the mono stack right after Paper Mono and before monospace', () => {
    expect(MONO_STACK.startsWith('"Paper Mono", "Termul Symbols"')).toBe(true)
    expect(MONO_FONT_FAMILY[MONO_FONT_FAMILY.length - 1]).toBe('monospace')
    expect(SYMBOLS_FONT_FAMILY).toBe('"Termul Symbols"')
  })

  it('is declared in index.css under that same family name', () => {
    const css = readFileSync('src/renderer/index.css', 'utf8')
    expect(css).toContain(`font-family: ${SYMBOLS_FONT_FAMILY}`)
    expect(css).toContain('termul-symbols/TermulSymbols.woff2')
  })

  it('ships the face and its licence', () => {
    expect(readFileSync(`${FONT_DIR}/TermulSymbols.woff2`).length).toBeGreaterThan(100_000)
    expect(readFileSync(`${FONT_DIR}/LICENSE`, 'utf8')).toContain('MIT License')
  })
})
