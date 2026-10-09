import { type RefObject, useCallback, useRef } from 'react'

export interface SheetCloseFocus {
  /** Call when a sheet row was chosen, so focus lands on the destination title. */
  markItemChosen: () => void
  /** Pass to `SheetContent` as `onCloseAutoFocus`. */
  onCloseAutoFocus: (event: Event) => void
}

/**
 * Focus return for a bottom sheet whose opener is a plain Button. Radix refocuses
 * only a `Dialog.Trigger`, so without this the focus drops to `<body>` on close.
 *
 * On close: when another surface (Git sheet, Files, palette, a modal) already
 * took focus, leave it. Otherwise focus `titleRef` after a row was chosen (the
 * destination changed) and `openerRef` after a plain dismissal. A sheet with no
 * `titleRef` always returns to its opener.
 */
export function useSheetCloseFocus(
  openerRef: RefObject<HTMLElement>,
  titleRef?: RefObject<HTMLElement>
): SheetCloseFocus {
  const itemChosenRef = useRef(false)

  const markItemChosen = useCallback((): void => {
    itemChosenRef.current = true
  }, [])

  const onCloseAutoFocus = useCallback(
    (event: Event): void => {
      event.preventDefault()
      const chosen = itemChosenRef.current
      itemChosenRef.current = false
      if (document.activeElement && document.activeElement !== document.body) return
      const target = chosen && titleRef ? titleRef : openerRef
      target.current?.focus()
    },
    [openerRef, titleRef]
  )

  return { markItemChosen, onCloseAutoFocus }
}
