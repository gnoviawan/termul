import { beforeAll, describe, expect, test } from 'bun:test'
import { oklchComponentsToHex } from '@/lib/themes/color-utils'
import { formatColor } from '../css-value'
import { TAILWIND_COLOR_VARS } from '../generated/tailwind-colors'
import { resolveTwTheme, THEME_IDS, themeColorTable } from '../theme'

/** Tokens whose OKLCH value lies outside sRGB: the renderer's hex helper reduces chroma there. */
const OUT_OF_GAMUT = new Set([
  'termul --accent-foreground',
  'termul --primary-foreground',
  'nord-light --warning-foreground'
])

/** The custom properties applyColorTheme writes, captured from a stand-in document. */
const written = new Map<string, string>()

beforeAll(() => {
  const root = {
    style: {
      setProperty: (key: string, value: string) => written.set(key, value),
      colorScheme: ''
    },
    classList: { add() {}, remove() {} },
    dataset: {} as Record<string, string>
  }
  Object.assign(globalThis, {
    document: {
      documentElement: root,
      getElementById: () => null,
      createElement: () => ({ id: '', append() {}, remove() {} }),
      createTextNode: (text: string) => text,
      head: { append() {} },
      body: { offsetHeight: 0 }
    },
    window: { dispatchEvent() {} },
    CustomEvent: class {
      constructor(
        public type: string,
        public detail: unknown
      ) {}
    },
    requestAnimationFrame: () => 0
  })
})

async function domTokens(themeId: string): Promise<Map<string, string>> {
  const { applyColorTheme } = await import('@/lib/themes/apply-color-theme')
  written.clear()
  applyColorTheme(themeId)
  return new Map(written)
}

describe('GPUIX theme tokens match what the DOM path writes', () => {
  for (const themeId of ['termul', 'nord-light']) {
    test(`${themeId}: every custom property equals applyColorTheme's write`, async () => {
      const dom = await domTokens(themeId)
      const { vars } = resolveTwTheme(themeId)
      expect(dom.size).toBe(66)
      for (const [key, value] of dom) expect({ key, value: vars[key] }).toEqual({ key, value })
    })

    test(`${themeId}: in-gamut colours equal the renderer's own hex conversion`, async () => {
      const dom = await domTokens(themeId)
      const theme = resolveTwTheme(themeId)
      for (const [name, ref] of Object.entries(TAILWIND_COLOR_VARS)) {
        const value = dom.get(ref)
        if (value === undefined || OUT_OF_GAMUT.has(`${themeId} ${ref}`)) continue
        expect({ name, hex: formatColor(theme.colors[name]) }).toEqual({
          name,
          hex: oklchComponentsToHex(value)
        })
      }
    })
  }

  test('out-of-gamut tokens clip per channel like Chromium, not by chroma reduction', () => {
    // Pixels Chromium 1243 painted for `background: oklch(<token>)`, read back from a screenshot.
    expect(formatColor(resolveTwTheme('nord-light').colors['warning-foreground'])).toBe('#fff6f4')
    expect(formatColor(resolveTwTheme('termul').colors['accent-foreground'])).toBe('#f5f9ff')
    expect(formatColor(resolveTwTheme('catppuccin-light').colors['warning-foreground'])).toBe(
      '#fff7ef'
    )
  })

  test('termul dark literals', () => {
    const table = themeColorTable(resolveTwTheme('termul'))
    expect([
      table.background,
      table.foreground,
      table.card,
      table.border,
      table['primary-fill'],
      table.sidebar
    ]).toEqual(['#08090a', '#e5e5e6', '#0f1011', '#242526', '#246bdd', '#161718'])
  })

  test('nord-light literals', () => {
    const theme = resolveTwTheme('nord-light')
    const table = themeColorTable(theme)
    expect(theme.appearance).toBe('light')
    expect([
      table.background,
      table.foreground,
      table['muted-foreground'],
      table['row-hover']
    ]).toEqual(['#e0e5eb', '#303744', '#5b616a', '#30374408'])
  })

  test('all 20 bundled themes resolve every Tailwind colour', () => {
    expect(THEME_IDS.length).toBe(20)
    for (const id of THEME_IDS) {
      expect(Object.keys(resolveTwTheme(id).colors).length).toBe(
        Object.keys(TAILWIND_COLOR_VARS).length
      )
    }
  })
})
