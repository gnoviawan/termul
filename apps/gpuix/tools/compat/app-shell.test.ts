import { describe, expect, test } from 'bun:test'
import { defaultFilter, splitPartClasses } from '../../src/compat/shims/cmdk-model'
import { resolveViewportUnits } from '../../src/compat/translate'

describe('viewport lengths', () => {
  test('arbitrary vh and vw values become px of the window', () => {
    expect(resolveViewportUnits('flex h-[90vh] md:h-[85vh] md:w-[90vw] max-h-[52vh] pt-[7vh]', 1280, 800)).toBe(
      'flex h-[720px] md:h-[680px] md:w-[1152px] max-h-[416px] pt-[56px]'
    )
  })

  test('dynamic viewport units and calc() operands are resolved too; other classes are untouched', () => {
    expect(resolveViewportUnits('h-[100dvh] max-h-[calc(100vh-2rem)] overflow-hidden', 1000, 700)).toBe(
      'h-[700px] max-h-[calc(700px-2rem)] overflow-hidden'
    )
    expect(resolveViewportUnits('h-screen w-full overflow-visible', 1000, 700)).toBe('h-screen w-full overflow-visible')
  })
})

describe('cmdk stand-in', () => {
  test("an ancestor's [&_[cmdk-part]] classes are split out per part", () => {
    expect(
      splitPartClasses(
        'flex [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-item]]:py-3 rounded-md'
      )
    ).toEqual({
      own: 'flex rounded-md',
      parts: { 'group-heading': 'px-2.5 text-xs', item: 'py-3' }
    })
  })

  test('the filter keeps substrings and in-order letters, and drops the rest', () => {
    expect(defaultFilter('App Preferences open global application preferences', 'prefs')).toBe(0.5)
    expect(defaultFilter('New Terminal', 'term')).toBe(1)
    expect(defaultFilter('New Terminal', '')).toBe(1)
    expect(defaultFilter('New Terminal', 'xyz')).toBe(0)
    expect(defaultFilter('alpha', 'repo', ['repository'])).toBe(1)
  })
})
