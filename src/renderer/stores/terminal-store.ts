import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Terminal, GitStatus, TerminalHealthStatus } from '@/types/project'
import { useProjectStore } from './project-store'

const GLOBAL_TERMINAL_LIMIT = 30
export const HIDDEN_BUFFER_TRUNCATION_DELAY = 15 * 60 * 1000 // 15 minutes
export const TRUNCATED_BUFFER_SIZE = 5000
export const MAX_TRANSCRIPT_CHARS = 1_500_000
const LINE_BREAK_PATTERN = /\r\n|\r|\n/

function trimTranscriptToMaxChars(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return transcript
  }

  const tail = transcript.slice(-MAX_TRANSCRIPT_CHARS)
  const firstBreak = LINE_BREAK_PATTERN.exec(tail)
  return firstBreak ? tail.slice(firstBreak.index + firstBreak[0].length) : tail
}

function trimTranscriptToRecentLines(transcript: string): string {
  return transcript.split(LINE_BREAK_PATTERN).slice(-TRUNCATED_BUFFER_SIZE).join('\n')
}

export interface TerminalState {
  // State
  terminals: Terminal[]
  activeTerminalId: string
  // Index for O(1) ptyId lookups
  ptyIdIndex: Map<string, string>

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
  setTerminalPtyId: (id: string, ptyId: string) => boolean
  findTerminalByPtyId: (ptyId: string) => Terminal | undefined
  updateTerminalCwd: (id: string, cwd: string) => void
  updateTerminalGitBranch: (id: string, gitBranch: string | null) => void
  updateTerminalGitStatus: (id: string, gitStatus: GitStatus | null) => void
  updateTerminalExitCode: (id: string, exitCode: number | null) => void
  updateTerminalScrollback: (id: string, scrollback: string[] | undefined) => void
  appendTranscript: (ptyId: string, data: string) => void
  peekTranscript: (ptyId: string) => string
  consumeTranscript: (ptyId: string) => string
  appendDetachedOutput: (ptyId: string, data: string) => void
  consumeDetachedOutput: (ptyId: string) => string
  setRendererAttached: (ptyId: string, attached: boolean) => void
  setTerminalHealthStatus: (id: string, status: TerminalHealthStatus) => void
  setTerminalHidden: (id: string, isHidden: boolean) => void
  setAppHidden: (isHidden: boolean) => void
  /** @deprecated Use updateTerminalActivityBatch instead */
  updateTerminalActivity: (id: string, hasActivity: boolean) => void
  /** @deprecated Use updateTerminalActivityBatch instead */
  updateTerminalLastActivityTimestamp: (id: string, timestamp: number) => void
  restartTerminal: (id: string) => void
  updateTerminalActivityBatch: (id: string, hasActivity: boolean, timestamp: number) => void
  clearTerminalPtyId: (ptyId: string) => void
  truncateHiddenTerminalBuffers: () => void
  cleanupProjectTerminals: (projectId: string) => void
  getTerminalCount: () => number
  isTerminalLimitReached: () => boolean
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: '',
  ptyIdIndex: new Map(),

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
      isHidden: false
    }
    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: newTerminal.id
    }))
    return newTerminal
  },

  closeTerminal: (id: string, projectId: string): void => {
    const { terminals, activeTerminalId, ptyIdIndex } = get()
    const closedTerminal = terminals.find((t) => t.id === id)
    const remaining = terminals.filter((t) => t.id !== id)
    const projectTerminals = remaining.filter((t) => t.projectId === projectId)

    const newIndex = new Map(ptyIdIndex)
    if (closedTerminal?.ptyId) {
      newIndex.delete(closedTerminal.ptyId)
    }

    set({
      terminals: remaining,
      ptyIdIndex: newIndex,
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
    const newIndex = new Map<string, string>()
    for (const t of terminals) {
      if (t.ptyId) newIndex.set(t.ptyId, t.id)
    }
    set({ terminals, ptyIdIndex: newIndex })
  },

  setTerminalPtyId: (id: string, ptyId: string): boolean => {
    let didSet = false
    set((state) => {
      const target = state.terminals.find((t) => t.id === id)
      if (!target) {
        return state
      }

      if (target.ptyId && target.ptyId !== ptyId) {
        return state
      }

      const existingOwner = state.ptyIdIndex.get(ptyId)
      if (existingOwner && existingOwner !== id) {
        return state
      }

      const newIndex = new Map(state.ptyIdIndex)
      if (target.ptyId && target.ptyId !== ptyId) {
        newIndex.delete(target.ptyId)
      }
      newIndex.set(ptyId, id)
      didSet = true

      return {
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, ptyId } : t)),
        ptyIdIndex: newIndex
      }
    })
    return didSet
  },

  findTerminalByPtyId: (ptyId: string): Terminal | undefined => {
    const state = get()
    const terminalId = state.ptyIdIndex.get(ptyId)
    if (terminalId) {
      return state.terminals.find((t) => t.id === terminalId)
    }
    // Fallback to linear scan (for terminals set before index existed)
    return state.terminals.find((t) => t.ptyId === ptyId)
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

  updateTerminalScrollback: (id: string, scrollback: string[] | undefined): void => {
    set((state) => {
      const target = state.terminals.find((t) => t.id === id)
      if (!target || target.pendingScrollback === scrollback) {
        return state
      }

      return {
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, pendingScrollback: scrollback } : t
        )
      }
    })
  },

  appendTranscript: (ptyId: string, data: string): void => {
    if (!data) return

    set((state) => {
      const hasTarget = state.terminals.some((t) => t.ptyId === ptyId)
      if (!hasTarget) {
        return state
      }

      return {
        terminals: state.terminals.map((t) => {
          if (t.ptyId !== ptyId) {
            return t
          }

          const combined = (t.transcript || '') + data

          return {
            ...t,
            transcript: trimTranscriptToMaxChars(combined)
          }
        })
      }
    })
  },

  peekTranscript: (ptyId: string): string => {
    const target = get().terminals.find((t) => t.ptyId === ptyId)
    return target?.transcript ?? ''
  },

  consumeTranscript: (ptyId: string): string => {
    let consumed = ''

    set((state) => {
      const target = state.terminals.find((t) => t.ptyId === ptyId && t.transcript)
      if (!target) {
        return state
      }

      consumed = target.transcript ?? ''

      return {
        terminals: state.terminals.map((t) => {
          if (t.ptyId !== ptyId || !t.transcript) {
            return t
          }

          return {
            ...t,
            transcript: undefined
          }
        })
      }
    })

    return consumed
  },

  appendDetachedOutput: (ptyId: string, data: string): void => {
    if (!data) return

    set((state) => {
      const hasTarget = state.terminals.some((t) => t.ptyId === ptyId)
      if (!hasTarget) {
        return state
      }

      return {
        terminals: state.terminals.map((t) => {
          if (t.ptyId !== ptyId) {
            return t
          }

          return {
            ...t,
            detachedOutput: trimTranscriptToMaxChars((t.detachedOutput || '') + data)
          }
        })
      }
    })
  },

  consumeDetachedOutput: (ptyId: string): string => {
    let consumed = ''

    set((state) => {
      const target = state.terminals.find((t) => t.ptyId === ptyId && t.detachedOutput)
      if (!target) {
        return state
      }

      consumed = target.detachedOutput || ''

      return {
        terminals: state.terminals.map((t) => {
          if (t.ptyId !== ptyId || !t.detachedOutput) {
            return t
          }

          return {
            ...t,
            detachedOutput: ''
          }
        })
      }
    })

    return consumed
  },

  setRendererAttached: (ptyId: string, attached: boolean): void => {
    set((state) => {
      const target = state.terminals.find((t) => t.ptyId === ptyId)
      if (!target) {
        return state
      }

      const currentCount = target.rendererAttachmentCount ?? 0
      const nextCount = attached ? currentCount + 1 : Math.max(0, currentCount - 1)

      if (nextCount === currentCount) {
        return state
      }

      return {
        terminals: state.terminals.map((t) => {
          if (t.ptyId !== ptyId) {
            return t
          }

          return {
            ...t,
            rendererAttachmentCount: nextCount
          }
        })
      }
    })
  },

  setTerminalHealthStatus: (id: string, status: TerminalHealthStatus): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, healthStatus: status } : t))
    }))
  },

  setTerminalHidden: (id: string, isHidden: boolean): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => {
        if (t.id !== id) {
          return t
        }

        if (t.isHidden === isHidden) {
          return t
        }

        return {
          ...t,
          isHidden,
          hiddenSince: isHidden ? Date.now() : undefined
        }
      })
    }))
  },

  setAppHidden: (isHidden: boolean): void => {
    set((state) => {
      // Avoid allocating a new array if every terminal already has the correct state
      if (state.terminals.every((t) => t.isAppHidden === isHidden)) {
        return state
      }

      return {
        terminals: state.terminals.map((t) => {
          if (t.isAppHidden === isHidden) {
            return t
          }

          return {
            ...t,
            isAppHidden: isHidden,
            appHiddenSince: isHidden ? Date.now() : undefined
          }
        })
      }
    })
  },

  /** @deprecated Use updateTerminalActivityBatch instead */
  updateTerminalActivity: (id: string, hasActivity: boolean): void => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, hasActivity } : t))
    }))
  },

  /** @deprecated Use updateTerminalActivityBatch instead */
  updateTerminalLastActivityTimestamp: (id: string, timestamp: number): void => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, lastActivityTimestamp: timestamp } : t
      )
    }))
  },

  restartTerminal: (id: string): void => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id)
      if (!terminal) return state
      const newPtyId = `restart-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
      return {
        terminals: state.terminals.map((t) =>
          t.id === id
            ? { ...t, ptyId: newPtyId, healthStatus: 'running', transcript: undefined, pendingScrollback: undefined }
            : t
        ),
        activeTerminalId: id
      }
    })
  },

  updateTerminalActivityBatch: (id: string, hasActivity: boolean, timestamp: number): void => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, hasActivity, lastActivityTimestamp: timestamp } : t
      )
    }))
  },

  clearTerminalPtyId: (ptyId: string): void => {
    set((state) => {
      const newIndex = new Map(state.ptyIdIndex)
      newIndex.delete(ptyId)
      return {
        terminals: state.terminals.map((t) => (t.ptyId === ptyId ? { ...t, ptyId: undefined } : t)),
        ptyIdIndex: newIndex
      }
    })
  },

  truncateHiddenTerminalBuffers: (): void => {
    const now = Date.now()
    set((state) => ({
      terminals: state.terminals.map((t) => {
        const hiddenSince = t.appHiddenSince ?? t.hiddenSince
        const isEligibleForTruncation =
          (t.isAppHidden || t.isHidden) &&
          hiddenSince !== undefined &&
          now - hiddenSince > HIDDEN_BUFFER_TRUNCATION_DELAY

        if (!isEligibleForTruncation) {
          return t
        }

        const nextScrollback =
          t.pendingScrollback && t.pendingScrollback.length > TRUNCATED_BUFFER_SIZE
            ? t.pendingScrollback.slice(-TRUNCATED_BUFFER_SIZE)
            : t.pendingScrollback

        const nextTranscript = t.transcript
          ? (() => {
              const trimmedMax = trimTranscriptToMaxChars(t.transcript!)
              return trimmedMax === t.transcript && t.transcript!.length <= TRUNCATED_BUFFER_SIZE
                ? t.transcript
                : trimTranscriptToRecentLines(trimmedMax)
            })()
          : t.transcript

        const nextDetachedOutput = t.detachedOutput
          ? (() => {
              const trimmedMax = trimTranscriptToMaxChars(t.detachedOutput!)
              return trimmedMax === t.detachedOutput && t.detachedOutput!.length <= TRUNCATED_BUFFER_SIZE
                ? t.detachedOutput
                : trimTranscriptToRecentLines(trimmedMax)
            })()
          : t.detachedOutput

        if (
          nextScrollback === t.pendingScrollback &&
          nextTranscript === t.transcript &&
          nextDetachedOutput === t.detachedOutput
        ) {
          return t
        }

        return {
          ...t,
          pendingScrollback: nextScrollback,
          transcript: nextTranscript,
          detachedOutput: nextDetachedOutput
        }
      })
    }))
  },

  cleanupProjectTerminals: (projectId: string): void => {
    set((state) => ({
      terminals: state.terminals.filter((t) => t.projectId !== projectId),
      activeTerminalId:
        state.terminals.some((t) => t.id === state.activeTerminalId && t.projectId === projectId)
          ? ''
          : state.activeTerminalId
    }))
  },

  getTerminalCount: (): number => {
    return get().terminals.length
  },

  isTerminalLimitReached: (): boolean => {
    return get().terminals.length >= GLOBAL_TERMINAL_LIMIT
  }
}));

// Helper to cleanup project terminals from outside the store
export function cleanupProjectTerminals(projectId: string): void {
  useTerminalStore.getState().cleanupProjectTerminals(projectId)
}

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
  | 'selectTerminal'
  | 'addTerminal'
  | 'closeTerminal'
  | 'renameTerminal'
  | 'reorderTerminals'
  | 'updateTerminalCwd'
  | 'updateTerminalScrollback'
  | 'appendTranscript'
  | 'peekTranscript'
  | 'consumeTranscript'
  | 'appendDetachedOutput'
  | 'consumeDetachedOutput'
  | 'setRendererAttached'
  | 'setTerminalPtyId'
  | 'clearTerminalPtyId'
> {
  return useTerminalStore(
    useShallow((state) => ({
      selectTerminal: state.selectTerminal,
      addTerminal: state.addTerminal,
      closeTerminal: state.closeTerminal,
      renameTerminal: state.renameTerminal,
      reorderTerminals: state.reorderTerminals,
      updateTerminalCwd: state.updateTerminalCwd,
      updateTerminalScrollback: state.updateTerminalScrollback,
      appendTranscript: state.appendTranscript,
      peekTranscript: state.peekTranscript,
      consumeTranscript: state.consumeTranscript,
      appendDetachedOutput: state.appendDetachedOutput,
      consumeDetachedOutput: state.consumeDetachedOutput,
      setRendererAttached: state.setRendererAttached,
      setTerminalPtyId: state.setTerminalPtyId,
      clearTerminalPtyId: state.clearTerminalPtyId
    }))
  )
}

/**
 * Optimized selector that returns a Set of project IDs with active terminal activity.
 * Uses useShallow to prevent re-renders unless the set of active projects actually changes.
 */
export function useProjectsWithActivity(): string[] {
  return useTerminalStore(
    useShallow((state) => {
      const activeProjectIds = new Set<string>()
      for (const t of state.terminals) {
        // Skip dead terminals — they belong to the error indicator, not the spinner
        if (t.healthStatus === 'disconnected' || t.healthStatus === 'crashed') {
          continue
        }
        // Indikator menyala jika:
        // 1. Ada aktivitas output (hasActivity)
        // 2. Sedang proses awal loading/spawn (status running tapi PTY belum siap)
        if (t.hasActivity || (t.healthStatus === 'running' && !t.ptyId)) {
          activeProjectIds.add(t.projectId)
        }
      }
      return Array.from(activeProjectIds).sort()
    })
  )
}

/**
 * Returns a Set of project IDs that have at least one crashed or disconnected terminal.
 */
export function useProjectsWithErrors(): Set<string> {
  return useTerminalStore(
    useShallow((state) => {
      const errorProjectIds = new Set<string>()
      for (const t of state.terminals) {
        if (t.healthStatus === 'crashed' || t.healthStatus === 'disconnected') {
          errorProjectIds.add(t.projectId)
        }
      }
      return errorProjectIds
    })
  )
}
