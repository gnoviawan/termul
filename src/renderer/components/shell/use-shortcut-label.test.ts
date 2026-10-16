import { describe, expect, it } from 'vitest'
import { withShortcut } from './use-shortcut-label'

describe('withShortcut', () => {
  it('appends a bound shortcut and leaves the label alone without one', () => {
    expect(withShortcut('Hide side panel', 'Ctrl+B')).toBe('Hide side panel (Ctrl+B)')
    expect(withShortcut('Hide side panel', undefined)).toBe('Hide side panel')
  })
})
