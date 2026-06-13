import type { KeyboardEvent, RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { SlashMenuHandle } from './SlashCommandMenu'
import { tryHandleSlashMenuKeyDown } from './slash-menu-keyboard'

function keyEvent(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    shiftKey: false,
    preventDefault: vi.fn(),
    nativeEvent: { isComposing: false },
    ...extra
  } as unknown as KeyboardEvent
}

describe('tryHandleSlashMenuKeyDown', () => {
  it('returns false when the menu is closed', () => {
    const menuRef: RefObject<SlashMenuHandle | null> = { current: null }
    const handled = tryHandleSlashMenuKeyDown(keyEvent('Tab'), {
      menuOpen: false,
      sectionsLength: 2,
      menuRef,
      onClearInput: vi.fn()
    })
    expect(handled).toBe(false)
  })

  it('selects the highlighted item on Tab', () => {
    const selectHighlighted = vi.fn(() => true)
    const menuRef: RefObject<SlashMenuHandle | null> = {
      current: { move: vi.fn(), selectHighlighted }
    }

    const handled = tryHandleSlashMenuKeyDown(keyEvent('Tab'), {
      menuOpen: true,
      sectionsLength: 2,
      menuRef,
      onClearInput: vi.fn()
    })

    expect(handled).toBe(true)
    expect(selectHighlighted).toHaveBeenCalledOnce()
  })
})
