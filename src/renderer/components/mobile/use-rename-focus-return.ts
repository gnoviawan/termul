import { type RefObject, useCallback, useEffect, useRef } from 'react'

export interface RenameFocusReturn {
  /**
   * Ref callback for a row's Actions button, keyed by the row's path key. Keeps
   * the button reachable after its row swaps to the rename input and back.
   */
  registerActionsButton: (pathKey: string) => (element: HTMLElement | null) => void
  /**
   * A rename ended and the row at `pathKey` should take focus on its Actions
   * button: at once when that button is mounted, else after the commit that
   * mounts it. Only while focus is lost; focus the user moved is never taken.
   */
  focusActionsButton: (pathKey: string) => void
  /**
   * Park focus on the Files sheet itself when nothing holds it. For a confirmed
   * Delete: its row can be gone before the confirm hands focus back, and the
   * sheet's own focus trap is paused underneath the confirm, so nothing else
   * catches the fall to `<body>`.
   */
  focusSheetIfLost: () => void
}

/**
 * Focus is lost when nothing holds it: no element, `<body>`, or the Files sheet's
 * own content element. Radix's focus trap parks focus on that element when the
 * focused node is removed from the sheet, as the rename input is when it ends.
 */
function isFocusLost(sheet: HTMLElement | null): boolean {
  const active = document.activeElement
  return !active || active === document.body || active === sheet
}

/**
 * Focus return for the Files sheet's inline rename. The rename `Input` replaces
 * the whole row, so the Actions button that opened it unmounts and a new element
 * mounts when the rename ends: the opener recorded for `file-actions-sheet`
 * cannot be the target. Buttons are tracked by path key instead, and the
 * target's key is whatever row the rename leaves behind (the original on a
 * cancel or a failure, the renamed path on a commit).
 *
 * One pending key at a time. It belongs to one folder of one open sheet, so
 * navigating or closing the sheet drops it. A pending key is tried after every
 * commit of the host, not from the button's ref callback: Radix detaches and
 * reattaches the sheet's ref on a re-render, and a child's ref callback runs
 * before the parent's reattaches, so `sheetRef.current` is null there.
 *
 * @param sheetRef the Files `SheetContent`, for the lost-focus check.
 * @param open whether the Files sheet is open.
 * @param folder the folder the sheet shows.
 */
export function useRenameFocusReturn(
  sheetRef: RefObject<HTMLElement | null>,
  open: boolean,
  folder: string | null
): RenameFocusReturn {
  const buttonsRef = useRef(new Map<string, HTMLElement>())
  const pendingRef = useRef<string | null>(null)

  const consume = useCallback((): void => {
    const pathKey = pendingRef.current
    if (pathKey === null) return
    const button = buttonsRef.current.get(pathKey)
    if (!button?.isConnected) return
    pendingRef.current = null
    if (isFocusLost(sheetRef.current)) button.focus()
  }, [sheetRef])

  // biome-ignore lint/correctness/useExhaustiveDependencies: open and folder are the triggers; a pending return must not outlive the sheet or the folder it was requested in
  useEffect(() => {
    pendingRef.current = null
  }, [open, folder])

  // After every commit, so a button that mounts later (the renamed row once the
  // refreshed listing shows it) is found. Declared after the reset above, so a
  // commit that changed the folder drops the pending key first.
  useEffect(consume)

  const registerActionsButton = useCallback(
    (pathKey: string) =>
      (element: HTMLElement | null): void => {
        if (element) buttonsRef.current.set(pathKey, element)
        else buttonsRef.current.delete(pathKey)
      },
    []
  )

  const focusActionsButton = useCallback(
    (pathKey: string): void => {
      pendingRef.current = pathKey
      consume()
    },
    [consume]
  )

  const focusSheetIfLost = useCallback((): void => {
    const sheet = sheetRef.current
    const active = document.activeElement
    if (sheet?.isConnected && (!active || active === document.body)) sheet.focus()
  }, [sheetRef])

  return { registerActionsButton, focusActionsButton, focusSheetIfLost }
}
