import { describe, expect, test } from 'bun:test'
import { cellMetrics, terminalCharHeight } from './fonts'

describe('terminal cell geometry', () => {
  // Measured in the web client (Chromium, WebGL renderer) at the default
  // 14px Paper Mono, lineHeight 1.2: the grid is 8x19 px per cell.
  test('matches the cell xterm.js measures in Chromium at 14px', () => {
    expect(terminalCharHeight(14)).toBe(16)
    expect(cellMetrics(8.484, terminalCharHeight(14), 1.2)).toEqual({ width: 8, height: 19 })
  })

  test('rounds ascent and descent separately, like Blink', () => {
    // Paper Mono: ascent 955, descent 245 per 1000 units. At 20px: 19.1 + 4.9 -> 19 + 5.
    expect(terminalCharHeight(20)).toBe(24)
    // At 13px: 12.415 + 3.185 -> 12 + 3, where rounding the sum would give 16.
    expect(terminalCharHeight(13)).toBe(15)
  })
})
