import { expect, test } from 'bun:test'
import { caretKeystrokes } from '../native-editor'

test('the caret walks from the nearer end, one grapheme per arrow', () => {
  expect(caretKeystrokes('hello world', 2)).toBe('cmd-up right right')
  expect(caretKeystrokes('hello world', 10)).toBe('cmd-down left')
  expect(caretKeystrokes('a👍🏽b', 5)).toBe('cmd-down left')
  expect(caretKeystrokes('a👍🏽bcd', 1)).toBe('cmd-up right')
  expect(caretKeystrokes('', 0)).toBe('cmd-up')
})
