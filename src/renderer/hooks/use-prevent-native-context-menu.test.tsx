import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { usePreventNativeContextMenu } from '@/hooks/use-prevent-native-context-menu'

/**
 * Regression: the native-context-menu suppression hook must register its
 * `contextmenu` listener in BUBBLE phase, not capture. Radix's
 * `ContextMenuTrigger` opens via `composeEventHandlers` (from
 * `@radix-ui/primitive`), which skips `handleOpen` when
 * `event.defaultPrevented` is already true (`checkForDefaultPrevented`
 * defaults to true). A capture-phase `preventDefault()` sets that flag
 * before Radix's trigger handler runs, suppressing the global menu entirely
 * (right-click shows nothing). The co-located `GlobalContextMenu.test.tsx`
 * mocks the Radix primitive entirely, so it cannot catch this — this test
 * drives the REAL primitive to lock the ordering invariant.
 */
describe('usePreventNativeContextMenu', () => {
  it('does not block Radix ContextMenuTrigger from opening (bubble, not capture)', () => {
    const onOpenChange = vi.fn()

    function Harness() {
      usePreventNativeContextMenu()
      return (
        <ContextMenu onOpenChange={onOpenChange}>
          <ContextMenuTrigger asChild>
            <button type="button">surface</button>
          </ContextMenuTrigger>
        </ContextMenu>
      )
    }

    const { getByRole } = render(<Harness />)
    const button = getByRole('button', { name: 'surface' })

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    let dispatched = true
    act(() => {
      dispatched = button.dispatchEvent(event)
    })

    // Radix's trigger must still open the menu despite the suppression hook.
    // (Radix's useControllableState fires onOpenChange in a deferred effect,
    // so the dispatch must be wrapped in act() to flush it first.)
    expect(onOpenChange).toHaveBeenCalledWith(true)
    // The native menu is still suppressed (Radix's own preventDefault fires
    // after handleOpen; the hook's preventDefault is redundant here).
    expect(event.defaultPrevented).toBe(true)
    // dispatchEvent returns false when the event was cancelled (preventDefault).
    expect(dispatched).toBe(false)
  })
})
