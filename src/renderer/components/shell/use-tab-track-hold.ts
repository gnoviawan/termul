import type React from 'react'
import { useEffect, useRef, useState } from 'react'

export interface TabTrackHold {
  /** Whether the collapsed Rail renders its Column tab track. */
  showTrack: boolean
  /** Put on the collapsed Rail's root element. */
  railRef: React.RefObject<HTMLDivElement>
  onPointerEnter: (event: React.PointerEvent) => void
  onPointerLeave: (event: React.PointerEvent) => void
  /** Put on the tab track: a tab click arms the hold. */
  onTrackClickCapture: () => void
}

/**
 * Whether the collapsed Rail shows the Column tab track. While the Side panel
 * is on screen it shows the tabs itself, so the Rail shows none. A Rail tab
 * click opens the Side panel, though, and dropping the track at once moves
 * every button below it up under the pointer, so a second click lands on
 * Search, Canvas or Automations (#1725). After a tab click the track stays
 * until the last pointer leaves the Rail or a press lands outside it (a touch
 * tap fires `pointerleave` before `click`). Opening the Side panel any other
 * way removes the track at once.
 */
export function useTabTrackHold(sidePanelOnScreen: boolean): TabTrackHold {
  const railRef = useRef<HTMLDivElement>(null)
  const pointersInside = useRef(new Set<number>())
  const [held, setHeld] = useState(false)
  const [lastOnScreen, setLastOnScreen] = useState(sidePanelOnScreen)
  // Derived during render, so a closing Side panel never leaves a stale hold.
  if (lastOnScreen !== sidePanelOnScreen) {
    setLastOnScreen(sidePanelOnScreen)
    if (!sidePanelOnScreen) setHeld(false)
  }

  useEffect(() => {
    if (!held) return
    const releaseOutside = (event: PointerEvent): void => {
      const rail = railRef.current
      if (rail && event.target instanceof Node && rail.contains(event.target)) return
      setHeld(false)
    }
    document.addEventListener('pointerdown', releaseOutside, true)
    return () => document.removeEventListener('pointerdown', releaseOutside, true)
  }, [held])

  return {
    showTrack: !sidePanelOnScreen || held,
    railRef,
    onPointerEnter: (event) => {
      pointersInside.current.add(event.pointerId)
    },
    onPointerLeave: (event) => {
      pointersInside.current.delete(event.pointerId)
      if (pointersInside.current.size === 0) setHeld(false)
    },
    onTrackClickCapture: () => {
      if (!sidePanelOnScreen) setHeld(true)
    }
  }
}
