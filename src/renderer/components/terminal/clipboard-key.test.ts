import { describe, expect, it } from 'vitest'
import { decideTerminalClipboardKey, type TerminalClipboardKeyInput } from './clipboard-key'

const input = (over: Partial<TerminalClipboardKeyInput>): TerminalClipboardKeyInput => ({
  key: 'c',
  platformModifier: true,
  hasSelection: () => true,
  clipboardAvailable: () => true,
  now: 1000,
  lastClipboardOp: 0,
  ...over
})

describe('decideTerminalClipboardKey', () => {
  it('maps the platform-modifier keys like the xterm handler', () => {
    expect(decideTerminalClipboardKey(input({}))).toBe('copy')
    expect(decideTerminalClipboardKey(input({ key: 'C', hasSelection: () => false }))).toBe(
      'interrupt'
    )
    expect(decideTerminalClipboardKey(input({ key: 'v' }))).toBe('paste')
    expect(decideTerminalClipboardKey(input({ key: 'v', clipboardAvailable: () => false }))).toBe(
      'native-paste'
    )
    expect(decideTerminalClipboardKey(input({ key: 'a' }))).toBe('select-all')
    expect(decideTerminalClipboardKey(input({ key: 'l' }))).toBeNull()
    expect(decideTerminalClipboardKey(input({ platformModifier: false }))).toBeNull()
  })

  it('swallows any modified key within the rate limit of the last clipboard op', () => {
    expect(decideTerminalClipboardKey(input({ key: 'l', now: 1050, lastClipboardOp: 1000 }))).toBe(
      'rate-limited'
    )
    expect(decideTerminalClipboardKey(input({ now: 1100, lastClipboardOp: 1000 }))).toBe('copy')
  })
})
