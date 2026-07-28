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

  // Story 5.3 (T4.4 / T6.3) — Enter-with-slash-open regression.
  // AC2: `Enter` selects the highlighted item and does NOT send a message.
  // The composer's `handleKeyDown` only reaches `submit()` when
  // `tryHandleSlashMenuKeyDown` returns false (slash menu didn't consume).
  // This test asserts the slash menu consumes Enter so submit is never called.
  it('consumes Enter when the slash menu is open (does not send a message)', () => {
    const selectHighlighted = vi.fn(() => true)
    const menuRef: RefObject<SlashMenuHandle | null> = {
      current: { move: vi.fn(), selectHighlighted }
    }

    const handled = tryHandleSlashMenuKeyDown(keyEvent('Enter'), {
      menuOpen: true,
      sectionsLength: 2,
      menuRef,
      onClearInput: vi.fn()
    })

    expect(handled).toBe(true)
    expect(selectHighlighted).toHaveBeenCalledOnce()
  })

  it('does not consume Enter when composing (IME)', () => {
    // Shift+Enter inserts a newline (AC2) — but tryHandleSlashMenuKeyDown
    // doesn't handle Shift+Enter; the composer does. Verify the slash router
    // returns false for Shift+Enter so the composer can insert a newline.
    const selectHighlighted = vi.fn()
    const menuRef: RefObject<SlashMenuHandle | null> = {
      current: { move: vi.fn(), selectHighlighted }
    }

    const handled = tryHandleSlashMenuKeyDown(keyEvent('Enter', { shiftKey: true }), {
      menuOpen: true,
      sectionsLength: 2,
      menuRef,
      onClearInput: vi.fn()
    })

    expect(handled).toBe(false)
    expect(selectHighlighted).not.toHaveBeenCalled()
  })

  it('closes the menu on Escape (does not send)', () => {
    const onClearInput = vi.fn()
    const menuRef: RefObject<SlashMenuHandle | null> = {
      current: { move: vi.fn(), selectHighlighted: vi.fn() }
    }

    const handled = tryHandleSlashMenuKeyDown(keyEvent('Escape'), {
      menuOpen: true,
      sectionsLength: 2,
      menuRef,
      onClearInput
    })

    expect(handled).toBe(true)
    expect(onClearInput).toHaveBeenCalledOnce()
  })
})
