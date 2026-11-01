import { useEffect, useState } from 'react'

/**
 * The device's primary pointer is a finger (phones, tablets). There a
 * long-press on text belongs to the OS: it selects, shows the selection
 * handles and the native Copy / Paste menu.
 */
const TOUCH_PRIMARY_QUERY = '(pointer: coarse)'

/** Call-time read of {@link TOUCH_PRIMARY_QUERY}. False without `matchMedia`. */
export function isTouchPrimaryPointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(TOUCH_PRIMARY_QUERY).matches
}

/** {@link isTouchPrimaryPointer}, kept live as input devices change. */
export function useTouchPrimaryPointer(): boolean {
  const [touchPrimary, setTouchPrimary] = useState(isTouchPrimaryPointer)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(TOUCH_PRIMARY_QUERY)
    const onChange = (): void => setTouchPrimary(mql.matches)
    onChange()
    // Safari before 14 has no MediaQueryList#addEventListener.
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [])
  return touchPrimary
}
