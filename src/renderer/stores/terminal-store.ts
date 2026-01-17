import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Terminal, GitStatus, TerminalHealthStatus } from '@/types/project'
import { useProjectStore } from './project-store'

const GLOBAL_TERMINAL_LIMIT = 30
const HIDDEN_BUFFER_TRUNCATION_DELAY = 5 * 60 * 1000 // 5 minutes
const TRUNCATED_BUFFER_SIZE = 1000

export interface TerminalState {
  // State
  terminals: Terminal[]
  activeTerminalId: string

  // Actions
  selectTerminal: (id: string) => void
  addTerminal: (
    name: string,
    projectId: string,
    shell?: Terminal['shell'],
    cwd?: string,
    pendingScrollback?: string[],
    worktreeId?: string,
    breadcrumbContext?: string
  ) => Terminal
  closeTerminal: (id: string, projectId: string) => void
  renameTerminal: (id: string, name: string) => void
  reorderTerminals: (projectId: string, orderedIds: string[]) => void
  setTerminals: (terminals: Terminal[]) => void
  setTerminalPtyId: (id: string, ptyId: string) => void
  findTerminalByPtyId: (ptyId: string) => Terminal | undefined
  updateTerminalCwd: (id: string, cwd: string) => void
  updateTerminalGitBranch: (id: string, gitBranch: string | null) => void
  updateTerminalGitStatus: (id: string, gitStatus: GitStatus | null) => void
  updateTerminalExitCode: (id: string, exitCode: number | null) => void
  setTerminalHealthStatus: (id: string, status: TerminalHealthStatus) => void
  setTerminalHidden: (id: string, isHidden: boolean) => void
  truncateHiddenTerminalBuffers: () => void
  getTerminalCount: () => number
  isTerminalLimitReached: () => boolean
  closeTerminalsByWorktreeId: (worktreeId: string) => void
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: '',

  selectTerminal: (id: string): void => {
    set((state) => ({
      activeTerminalId: id,
      terminals: state.terminals.map((t) => ({ ...t, isActive: t.id === id }))
    }))
  },

  addTerminal: (
    name: string,
    projectId: string,
    shell: Terminal['shell'] = 'powershell',
    cwd?: string,
    pendingScrollback?: string[],
    worktreeId?: string,
    breadcrumbContext?: string
  ): Terminal => {
    // Check global terminal limit
    const { terminals } = get()
    if (terminals.length >= GLOBAL_TERMINAL_LIMIT) {
      throw new Error(`Maximum ${GLOBAL_TERMINAL_LIMIT} terminals allowed across all projects`)
    }

    const newTerminal: Terminal = {
      id: Date.now().toString(),
      name,
      projectId,
      shell,
      cwd,
      output: [],
      pendingScrollback,
      healthStatus: 'running',
      isHidden: false,
      worktreeId,
      breadcrumbContext
    }
    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: newTerminal.id
    }))
    return newTerminal
  },

  closeTerminal: (id: string, projectId: string): void => {
    const { terminals, activeTerminalId } = get()
    const remaining = terminals.filter((t) => t.id !== id)
    const projectTerminals = remaining.filter((t) => t.projectId === projectId)

    set({
      terminals: remaining,
      activeTerminalId:
        activeTerminalId === id && projectTerminals.length > 0
          ? projectTerminals[0].id
          : activeTerminalId === id
            ? ''
            : activeTerminalId
    })
  },

  renameTerminal: (id: string, name: string): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, name } : t))
    }))
  },

  reorderTerminals: (projectId: string, orderedIds: string[]): void => {
    set((state) => {
      const projectTerminals = state.terminals.filter((t) => t.projectId === projectId)
      const otherTerminals = state.terminals.filter((t) => t.projectId !== projectId)

      const reordered = orderedIds
        .map((id) => projectTerminals.find((t) => t.id === id))
        .filter((t): t is Terminal => t !== undefined)

      return { terminals: [...otherTerminals, ...reordered] }
    })
  },

  setTerminals: (terminals: Terminal[]): void => {
    set({ terminals })
  },

  setTerminalPtyId: (id: string, ptyId: string): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, ptyId } : t))
    }))
  },

  findTerminalByPtyId: (ptyId: string): Terminal | undefined => {
    return get().terminals.find((t) => t.ptyId === ptyId)
  },

  updateTerminalCwd: (id: string, cwd: string): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, cwd } : t))
    }))
  },

  updateTerminalGitBranch: (id: string, gitBranch: string | null): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, gitBranch } : t))
    }))
  },

  updateTerminalGitStatus: (id: string, gitStatus: GitStatus | null): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, gitStatus } : t))
    }))
  },

  updateTerminalExitCode: (id: string, exitCode: number | null): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, lastExitCode: exitCode } : t))
    }))
  },

  setTerminalHealthStatus: (id: string, status: TerminalHealthStatus): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, healthStatus: status } : t))
    }))
  },

  setTerminalHidden: (id: string, isHidden: boolean): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => {
        if (t.id === id) {
          return {
            ...t,
            isHidden,
            hiddenSince: isHidden ? Date.now() : undefined
          }
        }
        return t
      })
    }))
  },

  truncateHiddenTerminalBuffers: (): void => {
    const now = Date.now()
    set((state) => ({
      terminals: state.terminals.map((t) => {
        // Only truncate hidden terminals that have been hidden for longer than the delay
        if (
          t.isHidden &&
          t.hiddenSince &&
          (now - t.hiddenSince) > HIDDEN_BUFFER_TRUNCATION_DELAY &&
          t.pendingScrollback &&
          t.pendingScrollback.length > TRUNCATED_BUFFER_SIZE
        ) {
          // Keep the last TRUNCATED_BUFFER_SIZE lines
          return {
            ...t,
            pendingScrollback: t.pendingScrollback.slice(-TRUNCATED_BUFFER_SIZE)
          }
        }
        return t
      })
    }))
  },

  getTerminalCount: (): number => {
    return get().terminals.length
  },

  isTerminalLimitReached: (): boolean => {
    return get().terminals.length >= GLOBAL_TERMINAL_LIMIT
  },

  closeTerminalsByWorktreeId: (worktreeId: string): void => {
    const { terminals, activeTerminalId } = get()
    const toRemove = terminals.filter((t) => t.worktreeId === worktreeId)
    const remaining = terminals.filter((t) => t.worktreeId !== worktreeId)

    // Update active terminal if it was closed
    const newActiveId = toRemove.some((t) => t.id === activeTerminalId)
      ? remaining.find((t) => t.projectId === toRemove[0]?.projectId)?.id || ''
      : activeTerminalId

    set({
      terminals: remaining,
      activeTerminalId: newActiveId
    })
  }
}))

// Selectors for performance (selective subscriptions)
// These selectors use the project store's activeProjectId for filtering

export function useTerminals(): Terminal[] {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  return useTerminalStore(
    useShallow((state) => state.terminals.filter((t) => t.projectId === activeProjectId))
  )
}

export function useAllTerminals(): Terminal[] {
  return useTerminalStore(useShallow((state) => state.terminals))
}

export function useActiveTerminal(): Terminal | undefined {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  return useTerminalStore((state) => {
    const projectTerminals = state.terminals.filter((t) => t.projectId === activeProjectId)
    // Find by activeTerminalId, or fall back to first terminal in project
    const activeById = projectTerminals.find((t) => t.id === state.activeTerminalId)
    return activeById || projectTerminals[0]
  })
}

export function useActiveTerminalId(): string {
  return useTerminalStore((state) => state.activeTerminalId)
}

export function useTerminalActions(): Pick<
  TerminalState,
  'selectTerminal' | 'addTerminal' | 'closeTerminal' | 'renameTerminal' | 'reorderTerminals' | 'updateTerminalCwd' | 'setTerminalPtyId' | 'closeTerminalsByWorktreeId'
> {
  return useTerminalStore(
    useShallow((state) => ({
      selectTerminal: state.selectTerminal,
      addTerminal: state.addTerminal,
      closeTerminal: state.closeTerminal,
      renameTerminal: state.renameTerminal,
      reorderTerminals: state.reorderTerminals,
      updateTerminalCwd: state.updateTerminalCwd,
      setTerminalPtyId: state.setTerminalPtyId,
      closeTerminalsByWorktreeId: state.closeTerminalsByWorktreeId
    }))
  )
}
