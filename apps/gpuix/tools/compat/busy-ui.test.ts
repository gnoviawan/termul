import { expect, test } from 'bun:test'
import { busyTolerantReads } from '../../src/compat/busy-ui'
import type { CompatRenderer } from '../../src/compat/live-reads'

const timeout = (query: string) => () => {
  throw new Error(`Timed out after 2 seconds waiting for the ${query} query`)
}

const busy: CompatRenderer = {
  focusElement: () => {},
  blur: () => {},
  scrollTo: () => {},
  scrollIntoView: () => {},
  getFocusedElementId: timeout('focused element id'),
  getScrollOffset: timeout('GPUI scroll'),
  getElementBounds: timeout('bounds'),
  getAutomationTree: timeout('automation tree')
}

test('reads the busy UI thread timed out on answer "none" instead of throwing', () => {
  const reads = busyTolerantReads(busy)
  expect(reads.getFocusedElementId()).toBeNull()
  expect(reads.getScrollOffset(3)).toBeNull()
  expect(reads.getElementBounds(3)).toBeNull()
  expect(JSON.parse(reads.getAutomationTree())).toBeNull()
})

test('answered reads pass through, and other failures still throw', () => {
  const reads = busyTolerantReads({
    ...busy,
    getFocusedElementId: () => 42,
    getScrollOffset: () => [0, 120],
    getElementBounds: () => {
      throw new Error('GPUIX renderer is not initialized')
    }
  })
  expect(reads.getFocusedElementId()).toBe(42)
  expect(reads.getScrollOffset(3)).toEqual([0, 120])
  expect(() => reads.getElementBounds(3)).toThrow('GPUIX renderer is not initialized')
})
