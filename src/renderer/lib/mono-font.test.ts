import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MONO_FONT_FAMILY, MONO_STACK, SYMBOLS_FONT_FAMILY } from '@/lib/font-stacks'
import { logFrontendError } from '@/lib/log-api'
import { ensureMonoFontLoaded } from '@/lib/mono-font'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

// The bundled symbol face is what keeps Nerd Font / Powerline icons from
// rendering as tofu. Metrics must match Paper Mono (1000 upm, 606/1000 advance,
// 955/-245 vertical) or xterm's single-cell measurement puts icons outside
// their cell.
const FONT_DIR = 'src/renderer/assets/fonts/termul-symbols'

/** Replace `document.fonts` for one test, so a load can fail or resolve on cue. */
function stubFontLoads(load: (spec: string, text?: string) => Promise<FontFace[]>): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load, check: () => true }
  })
}

afterEach(() => {
  Reflect.deleteProperty(document, 'fonts')
  vi.restoreAllMocks()
})

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

describe('ensureMonoFontLoaded', () => {
  it('keeps waiting for Paper Mono when the symbol face fails first', async () => {
    let monoResolved = false
    stubFontLoads((spec) => {
      if (spec.includes('Termul Symbols')) return Promise.reject(new Error('symbols down'))
      return new Promise((resolve) =>
        setTimeout(() => {
          monoResolved = true
          resolve([])
        }, 20)
      )
    })

    const loaded = ensureMonoFontLoaded(14)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(monoResolved).toBe(false)
    await expect(loaded).resolves.toBeUndefined()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'mono-font.symbols', level: 'warn' })
    )
  })

  it('rejects when Paper Mono itself fails', async () => {
    stubFontLoads((spec) =>
      spec.includes('Termul Symbols') ? Promise.resolve([]) : Promise.reject(new Error('mono down'))
    )

    await expect(ensureMonoFontLoaded(14)).rejects.toThrow('mono down')
  })
})
