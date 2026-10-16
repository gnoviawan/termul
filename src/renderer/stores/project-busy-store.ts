import { create } from 'zustand'

/**
 * A delete, archive or root move the host refused because chats or terminals are
 * still bound to the project. It waits here for the user's decision; only
 * {@link ProjectBusyState.confirm} resends it with `cascade: true`. Nothing is
 * stopped by the renderer: the host stops the bound sessions and terminals.
 */
export interface ProjectBusyRequest {
  kind: 'delete' | 'archive' | 'move'
  projectId: string
  projectName: string
  /** Live chats bound to the project. */
  sessions: number
  /** Live terminals bound to the project. */
  terminals: number
  /** Resend the refused command with `cascade: true`. */
  resend: () => Promise<void>
}

interface ProjectBusyState {
  /** Refusals waiting for an answer, oldest first (a group delete can refuse several projects). */
  requests: ProjectBusyRequest[]
  /** `true` while the cascade resend of the first request runs. */
  isResending: boolean
  request: (request: ProjectBusyRequest) => void
  /** The user said no: the project stays as it is. */
  dismiss: () => void
  /** The user agreed: resend the first request with `cascade: true`. */
  confirm: () => Promise<void>
}

export const useProjectBusyStore = create<ProjectBusyState>((set, get) => ({
  requests: [],
  isResending: false,

  request: (request) => {
    set((state) => ({
      requests: [...state.requests.filter((r) => r.projectId !== request.projectId), request]
    }))
  },

  dismiss: () => {
    set((state) => ({ requests: state.requests.slice(1) }))
  },

  confirm: async () => {
    const [first] = get().requests
    if (!first || get().isResending) return
    set({ isResending: true })
    try {
      await first.resend()
    } finally {
      // A resend the host refuses again queues a fresh request for the same
      // project; drop only the one that was just answered.
      set((state) => ({
        isResending: false,
        requests: state.requests.filter((r) => r !== first)
      }))
    }
  }
}))
