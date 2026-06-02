import { create } from 'zustand'
import type { RemoteStatus } from '@shared/types/ipc.types'

/**
 * Global store for the embedded remote-terminal server status.
 *
 * Populated by `use-remote-projects` (which polls the backend) and updated
 * immediately when the user toggles remote access from the StatusBar popover.
 */
interface RemoteStatusStore {
  status: RemoteStatus | null
  setStatus: (status: RemoteStatus | null) => void
}

export const useRemoteStatusStore = create<RemoteStatusStore>((set) => ({
  status: null,
  setStatus: (status) => set({ status })
}))

/** Selector: current remote status (or null). */
export const useRemoteStatus = (): RemoteStatus | null =>
  useRemoteStatusStore((s) => s.status)
