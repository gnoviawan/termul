import { describe, expect, test } from 'bun:test'
import { convertDomStyle } from '../../src/compat/dom-style'

describe('inline grid placement', () => {
  test("SegmentedTrack's `span 2 / span 2` cell spans two columns", () => {
    expect(
      convertDomStyle({ gridColumn: 'span 2 / span 2', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' })
    ).toEqual({ gridColumnSpan: 2, gridTemplateColumns: 3 })
  })

  test('a row span and a bare `span 1`', () => {
    expect(convertDomStyle({ gridRow: 'span 3', gridColumn: 'span 1 / span 1' })).toEqual({
      gridRowSpan: 3,
      gridColumnSpan: 1
    })
  })

  test('a line placement is not a span and is left out', () => {
    expect(convertDomStyle({ gridColumn: '1 / 3' })).toEqual({})
  })
})
