import { create } from 'zustand'
import type { RemoteStatus } from '@shared/types/ipc.types'

/**
 * Global store for the embedded remote-terminal server status.
 *
 * Populated by `use-remote-projects` (which already polls the backend), and
 * consumed by the StatusBar to show a compact indicator while the server runs.
 *
 * `addressRevealed` controls whether the ip:port is shown in the StatusBar.
 * It defaults to `false` (hidden) so the address isn't exposed on screen —
 * e.g. during screen-sharing — until the user explicitly reveals it.
 */
interface RemoteStatusStore {
  status: RemoteStatus | null
  /** Whether the ip:port is currently shown in the StatusBar (default: hidden). */
  addressRevealed: boolean
  setStatus: (status: RemoteStatus | null) => void
  toggleAddressRevealed: () => void
  /** Hide the address again (e.g. when the server stops). */
  hideAddress: () => void
}

export const useRemoteStatusStore = create<RemoteStatusStore>((set) => ({
  status: null,
  addressRevealed: false,
  setStatus: (status) =>
    set((prev) => {
      // Re-hide the address whenever the server transitions to not-running,
      // so it never lingers revealed after a stop/restart.
      const stillRunning = status?.running ?? false
      return {
        status,
        addressRevealed: stillRunning ? prev.addressRevealed : false
      }
    }),
  toggleAddressRevealed: () => set((prev) => ({ addressRevealed: !prev.addressRevealed })),
  hideAddress: () => set({ addressRevealed: false })
}))

/** Selector: current remote status (or null). */
export const useRemoteStatus = (): RemoteStatus | null =>
  useRemoteStatusStore((s) => s.status)

/** Selector: whether the address is revealed in the StatusBar. */
export const useRemoteAddressRevealed = (): boolean =>
  useRemoteStatusStore((s) => s.addressRevealed)
