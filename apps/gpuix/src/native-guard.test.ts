import { describe, expect, test } from 'bun:test'
import type { NativeRenderer } from '@gpuix/react'
import { guardNativeQueries, orOnTimeout } from './native-guard'

const timeout = (what: string) => () => {
  throw new Error(`Timed out after 2 seconds waiting for ${what}`)
}

describe('guardNativeQueries', () => {
  test('a timed-out query returns its nothing-known value instead of throwing', () => {
    const renderer = {
      getFocusedElementId: timeout('the focused element id query'),
      getListScrollTop: timeout('the GPUI list scroll query')
    }
    guardNativeQueries(renderer as unknown as NativeRenderer)
    expect(renderer.getFocusedElementId()).toBeNull()
    expect(renderer.getListScrollTop()).toBeNull()
  })

  test('the automation tree read still throws its timeout, so drivers retry it', () => {
    const renderer = { getAutomationTree: timeout('the automation bounds query') }
    guardNativeQueries(renderer as unknown as NativeRenderer)
    expect(() => renderer.getAutomationTree()).toThrow('Timed out after 2 seconds')
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

describe('orOnTimeout', () => {
  test('answers the fallback for a timeout and rethrows anything else', () => {
    expect(orOnTimeout('getAutomationTree', timeout('the automation bounds query'), 'null')).toBe('null')
    expect(() =>
      orOnTimeout(
        'getAutomationTree',
        () => {
          throw new Error('Invalid element id')
        },
        'null'
      )
    ).toThrow('Invalid element id')
  })
})
