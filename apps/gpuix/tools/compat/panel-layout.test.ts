import { describe, expect, test } from 'bun:test'
import { defaultLayout, resizeAtHandle, validateLayout } from '../../src/compat/shims/panel-layout'

describe('defaultLayout', () => {
  test('stored pane sizes are kept', () => {
    expect(
      defaultLayout([
        { defaultSize: 30, minSize: 10 },
        { defaultSize: 70, minSize: 10 }
      ])
    ).toEqual([30, 70])
  })

  test('panels without a default share what is left', () => {
    expect(defaultLayout([{ defaultSize: 40 }, {}, {}])).toEqual([40, 30, 30])
  })

  test('a lone panel with a default of 75 fills the group', () => {
    expect(defaultLayout([{ defaultSize: 75, minSize: 60 }])).toEqual([100])
  })
})

describe('validateLayout', () => {
  test('a size under its minimum is raised and the next panel pays for it', () => {
    expect(validateLayout([5, 95], [{ minSize: 10 }, { minSize: 10 }])).toEqual([10, 90])
  })

  test('a layout of the wrong length throws like the package', () => {
    expect(() => validateLayout([50, 50], [{}])).toThrow('Invalid 1 panel layout: 50, 50')
  })
})

describe('resizeAtHandle', () => {
  const two = [{ minSize: 10 }, { minSize: 10 }]

  test('dragging right by 20% grows the left panel and shrinks the right one', () => {
    expect(resizeAtHandle([50, 50], 20, 0, two)).toEqual([70, 30])
  })

  test('dragging left stops at the left panel minimum', () => {
    expect(resizeAtHandle([50, 50], -60, 0, two)).toEqual([10, 90])
  })

  test('the outline panel stops at its maximum', () => {
    expect(
      resizeAtHandle([80, 20], -30, 0, [{ minSize: 60 }, { minSize: 15, maxSize: 35 }])
    ).toEqual([65, 35])
  })

  test('a shrink past the neighbour minimum carries on to the next panel', () => {
    expect(
      resizeAtHandle([40, 20, 40], 30, 0, [{ minSize: 10 }, { minSize: 10 }, { minSize: 10 }])
    ).toEqual([70, 10, 20])
  })
})
