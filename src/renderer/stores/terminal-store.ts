import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Terminal, GitStatus } from '@/types/project'
import { useProjectStore } from './project-store'

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
    pendingScrollback?: string[]
  ) => Terminal
  closeTerminal: (id: string, projectId: string) => void
  renameTerminal: (id: string, name: string) => void
  reorderTerminals: (projectId: string, orderedIds: string[]) => void
  setTerminals: (terminals: Terminal[]) => void
  updateTerminalCwd: (id: string, cwd: string) => void
  updateTerminalGitBranch: (id: string, gitBranch: string | null) => void
  updateTerminalGitStatus: (id: string, gitStatus: GitStatus | null) => void
  updateTerminalExitCode: (id: string, exitCode: number | null) => void
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
    pendingScrollback?: string[]
  ): Terminal => {
    const newTerminal: Terminal = {
      id: Date.now().toString(),
      name,
      projectId,
      shell,
      cwd,
      output: [],
      pendingScrollback
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
  'selectTerminal' | 'addTerminal' | 'closeTerminal' | 'renameTerminal' | 'reorderTerminals' | 'updateTerminalCwd'
> {
  return useTerminalStore(
    useShallow((state) => ({
      selectTerminal: state.selectTerminal,
      addTerminal: state.addTerminal,
      closeTerminal: state.closeTerminal,
      renameTerminal: state.renameTerminal,
      reorderTerminals: state.reorderTerminals,
      updateTerminalCwd: state.updateTerminalCwd
    }))
  )
}
