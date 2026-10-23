import { describe, expect, test } from 'bun:test'
import { formatColor, parseColor, parseLength, parseShadowList } from '../css-value'

/** Expected colours are the pixels Chromium paints for the same CSS. */
describe('css-value', () => {
  test('oklch with var() components and slash alpha', () => {
    expect(formatColor(parseColor('oklch(var(--x) / 0.5)', { '--x': '0.623 0.188 259.8' }))).toBe(
      '#3b82f680'
    )
  })

  test('color-mix in oklab against transparent keeps the colour and scales alpha', () => {
    expect(formatColor(parseColor('color-mix(in oklab, #e5e5e6 3%, transparent)'))).toBe(
      '#e5e5e608'
    )
  })

  test('color-mix toward black darkens in oklab', () => {
    expect(formatColor(parseColor('color-mix(in oklch, #246bdd 85%, black)'))).toBe('#1b55b2')
  })

  test('calc() over the spacing scale and rem', () => {
    expect(parseLength('calc(var(--spacing) * 3.5)', { '--spacing': '0.25rem' })).toBe(14)
    expect(parseLength('calc(0.5rem - 2px)')).toBe(6)
  })

  test('shadow lists with inset and oklch colours', () => {
    expect(parseShadowList('0 1px 2px oklch(0 0 0/0.22), inset 0 -1px 1px #00000029')).toEqual([
      {
        offsetX: 0,
        offsetY: 1,
        blurRadius: 2,
        spreadRadius: 0,
        color: { r: 0, g: 0, b: 0, a: 0.22 },
        inset: false
      },
      {
        offsetX: 0,
        offsetY: -1,
        blurRadius: 1,
        spreadRadius: 0,
        color: { r: 0, g: 0, b: 0, a: 41 / 255 },
        inset: true
      }
    ])
  })
})
