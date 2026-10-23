import { useTerminalStore } from '@/stores/terminal-store'

const ACTIVITY_DEBOUNCE_MS = 1000
const ACTIVITY_IDLE_MS = 2000

/**
 * The sidebar activity indicator for one terminal view: PTY output marks the
 * terminal active at most once per second, and two quiet seconds mark it idle.
 */
export interface TerminalActivity {
  /** PTY output arrived for the store terminal `terminalId`. */
  note(terminalId: string): void
  /** The view went away: drop pending updates and mark `storeTerminalId` idle. */
  clear(storeTerminalId: string | undefined): void
}

export function createTerminalActivity(): TerminalActivity {
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lastUpdate = 0
  let pending: { id: string } | null = null

  return {
    note(terminalId) {
      const now = Date.now()
      // If enough time has passed since last update, update immediately
      if (now - lastUpdate >= ACTIVITY_DEBOUNCE_MS) {
        useTerminalStore.getState().updateTerminalActivityBatch(terminalId, true, now)
        lastUpdate = now
      } else {
        // Otherwise, store pending update for later
        pending = { id: terminalId }
      }

      // Clear existing activity timeout and set new one
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        useTerminalStore
          .getState()
          .updateTerminalActivityBatch(pending ? pending.id : terminalId, false, Date.now())
        pending = null
        idleTimer = null
        lastUpdate = 0
      }, ACTIVITY_IDLE_MS)
    },
    clear(storeTerminalId) {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      pending = null
      lastUpdate = 0
      if (storeTerminalId) {
        useTerminalStore.getState().updateTerminalActivityBatch(storeTerminalId, false, Date.now())
      }
    }
  }
}

/** The store terminal a view's activity belongs to: by bound PTY id, else by its store or PTY target id. */
export function activityTerminalId(
  ptyId: string | null,
  targetId: string | undefined
): string | undefined {
  const store = useTerminalStore.getState()
  return (
    (ptyId ? store.findTerminalByPtyId(ptyId)?.id : undefined) ??
    (targetId
      ? (store.terminals.find((t) => t.id === targetId)?.id ??
        store.findTerminalByPtyId(targetId)?.id)
      : undefined)
  )
}
