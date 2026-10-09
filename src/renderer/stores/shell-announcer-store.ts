import { create } from 'zustand'

/**
 * Gap between clearing the shell live region and setting its next message.
 * React batches synchronous updates, so a clear immediately followed by a set
 * never reaches the DOM. The gap lets the empty region commit first, which is
 * what makes an identical repeat read as a new announcement to a screen
 * reader. It is also what keeps the region from ever being mounted holding
 * text.
 */
export const ANNOUNCE_DELAY_MS = 100

interface ShellAnnouncerState {
  /** Text currently shown in the shell live region. Empty while idle. */
  message: string
  /** Number of mounted shell live regions. `announce` is inert at zero. */
  regionCount: number
  /**
   * Register the persistently mounted live region. Returns the unregister
   * function. When the last region unregisters the message resets to empty and
   * any pending announcement is dropped.
   */
  registerRegion: () => () => void
  /**
   * Replace the live-region text. Inert while no region is mounted (desktop
   * shell, tests). One message at a time: a newer call cancels a pending one,
   * and the region is cleared before the new text lands so a repeat of the
   * same text is announced again.
   */
  announce: (text: string) => void
}

/** The single pending announcement. Module state: timers do not belong in the store. */
let pendingTimer: ReturnType<typeof setTimeout> | null = null

function cancelPending(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
}

/**
 * Renderer-only queue behind the mobile shell live region. Callers never touch
 * the DOM; `MobileChatShell` renders `message` into one persistent
 * `role="status"` element.
 */
export const useShellAnnouncerStore = create<ShellAnnouncerState>((set, get) => ({
  message: '',
  regionCount: 0,
  registerRegion: () => {
    set((state) => ({ regionCount: state.regionCount + 1 }))
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      const regionCount = Math.max(0, get().regionCount - 1)
      if (regionCount === 0) {
        cancelPending()
        set({ regionCount, message: '' })
      } else {
        set({ regionCount })
      }
    }
  },
  announce: (text) => {
    if (get().regionCount === 0) return
    cancelPending()
    set({ message: '' })
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      if (get().regionCount === 0) return
      set({ message: text })
    }, ANNOUNCE_DELAY_MS)
  }
}))

/** @internal test helper: drop the pending timer and restore the initial state. */
export function _resetShellAnnouncerForTests(): void {
  cancelPending()
  useShellAnnouncerStore.setState({ message: '', regionCount: 0 })
}
