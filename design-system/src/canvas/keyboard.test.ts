import { describe, expect, it } from 'vitest'
import { PAN_STEP, PAN_STEP_LARGE, viewportKeyCommand } from './keyboard'

const plain = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }

describe('viewportKeyCommand', () => {
  it('maps plain keys to camera commands', () => {
    expect(viewportKeyCommand({ ...plain, key: 'ArrowLeft' })).toEqual({
      type: 'pan',
      by: { x: PAN_STEP, y: 0 }
    })
    expect(viewportKeyCommand({ ...plain, key: 'ArrowDown', shiftKey: true })).toEqual({
      type: 'pan',
      by: { x: 0, y: -PAN_STEP_LARGE }
    })
    expect(viewportKeyCommand({ ...plain, key: '=' })).toEqual({ type: 'zoom-in' })
    expect(viewportKeyCommand({ ...plain, key: '+', shiftKey: true })).toEqual({ type: 'zoom-in' })
    expect(viewportKeyCommand({ ...plain, key: '-' })).toEqual({ type: 'zoom-out' })
    expect(viewportKeyCommand({ ...plain, key: '0' })).toEqual({ type: 'reset' })
    expect(viewportKeyCommand({ ...plain, key: 'f' })).toEqual({ type: 'fit' })
    expect(viewportKeyCommand({ ...plain, key: 'F', shiftKey: true })).toEqual({ type: 'fit' })
  })

  it('ignores unrelated keys', () => {
    expect(viewportKeyCommand({ ...plain, key: 'a' })).toBeNull()
    expect(viewportKeyCommand({ ...plain, key: 'Enter' })).toBeNull()
  })

  it.each([
    ['ctrlKey', 'f'],
    ['metaKey', 'f'],
    ['ctrlKey', '0'],
    ['metaKey', '0'],
    ['ctrlKey', '='],
    ['metaKey', '-'],
    ['altKey', 'ArrowLeft'],
    ['altKey', 'ArrowRight']
  ] as const)('leaves %s+%s to the browser', (modifier, key) => {
    expect(viewportKeyCommand({ ...plain, key, [modifier]: true })).toBeNull()
  })
})
