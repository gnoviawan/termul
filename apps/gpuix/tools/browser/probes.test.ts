import { describe, expect, test } from 'bun:test'
import { gpuixFramesBehind, runLengths } from './probes'

describe('gpuixFramesBehind', () => {
  test('counts the GPUIX divider positions the page trails during a drag to the right', () => {
    const frames = [
      { divider: 100, page: 101 },
      { divider: 105, page: 101 },
      { divider: 110, page: 106 },
      { divider: 115, page: 106 },
      { divider: 115, page: 116 },
      { divider: null, page: 116 }
    ]
    expect(gpuixFramesBehind(frames)).toEqual([0, 1, 1, 2, 0])
  })

  test('a page between two captured positions counts as one frame behind', () => {
    expect(gpuixFramesBehind([{ divider: 100, page: 103 }])).toEqual([1])
  })

  test('works for a drag to the left', () => {
    const frames = [
      { divider: 200, page: 201 },
      { divider: 190, page: 201 },
      { divider: 180, page: 201 }
    ]
    expect(gpuixFramesBehind(frames)).toEqual([0, 1, 2])
  })
})

test('runLengths', () => {
  expect(runLengths([true, true, false, true, false, false, true])).toEqual([2, 1, 1])
  expect(runLengths([])).toEqual([])
})
