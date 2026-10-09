import { useCallback, useEffect, useState } from 'react'

/**
 * Collapse state for a dock bar with a temporary "force collapsed" override
 * (the mobile dock collapses its plan and changed-files bars while the
 * on-screen keyboard is up and an approval is pending).
 *
 * While `force` is true the bar renders collapsed. A header tap during that
 * window flips the rendered state and the choice sticks until the window ends.
 * When `force` ends, the bar shows the user's last own state: whatever they
 * last set, or `initialCollapsed` if they never touched it.
 */
export function useForcedCollapse(
  initialCollapsed: boolean,
  force: boolean
): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [toggledDuringForce, setToggledDuringForce] = useState(false)

  // The mark only matters inside one force window.
  useEffect(() => {
    if (!force) setToggledDuringForce(false)
  }, [force])

  const effectiveCollapsed = force && !toggledDuringForce ? true : collapsed

  const toggle = useCallback(() => {
    setCollapsed(!effectiveCollapsed)
    if (force) setToggledDuringForce(true)
  }, [effectiveCollapsed, force])

  return { collapsed: effectiveCollapsed, toggle }
}
