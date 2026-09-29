import { afterEach, describe, expect, it } from 'vitest'
import { applyColorTheme } from '@/lib/themes/apply-color-theme'
import { oklchComponentsToHex } from '@/lib/themes/color-utils'
import { readCssTokenHex } from '@/lib/themes/read-css-token'
import { readMonochromeGradient } from './monochrome-spinner'

describe('readMonochromeGradient', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('reads foreground, muted-foreground, and background tokens', () => {
    applyColorTheme('termul')
    const gradient = readMonochromeGradient()
    expect(gradient).toEqual([
      { color: readCssTokenHex('--foreground'), position: 0 },
      { color: readCssTokenHex('--muted-foreground'), position: 0.5 },
      { color: readCssTokenHex('--background'), position: 1 }
    ])
    expect(gradient.map((stop) => stop.color)).not.toContain('#d4d4d8')
  })

  it('uses the :root first-paint stops when tokens are unset', () => {
    document.documentElement.removeAttribute('style')
    expect(readMonochromeGradient()).toEqual([
      { color: oklchComponentsToHex('0.909 0.008 260.7'), position: 0 },
      { color: oklchComponentsToHex('0.652 0.008 260.7'), position: 0.5 },
      { color: oklchComponentsToHex('0.2 0.01 268.2'), position: 1 }
    ])
  })
})
