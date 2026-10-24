import { describe, expect, test } from 'bun:test'
import type { NativeRenderer } from '@gpuix/react'
import { guardNativeQueries } from './native-guard'

const timeout = (what: string) => () => {
  throw new Error(`Timed out after 2 seconds waiting for ${what}`)
}

describe('guardNativeQueries', () => {
  test('a timed-out query returns its nothing-known value instead of throwing', () => {
    const renderer = {
      getFocusedElementId: timeout('the focused element id query'),
      getListScrollTop: timeout('the GPUI list scroll query'),
      getAutomationTree: timeout('the automation bounds query'),
      getElementsAt: timeout('the elements query')
    }
    guardNativeQueries(renderer as unknown as NativeRenderer)
    expect(renderer.getFocusedElementId()).toBeNull()
    expect(renderer.getListScrollTop()).toBeNull()
    expect(renderer.getAutomationTree()).toBe('null')
    expect(renderer.getElementsAt()).toEqual([])
  })

  test('answers pass through and other errors still throw', () => {
    const renderer = {
      getFocusedElementId: () => 42,
      getScrollOffset: () => {
        throw new Error('Invalid element id')
      }
    }
    guardNativeQueries(renderer as unknown as NativeRenderer)
    expect(renderer.getFocusedElementId()).toBe(42)
    expect(() => renderer.getScrollOffset()).toThrow('Invalid element id')
  })
})
