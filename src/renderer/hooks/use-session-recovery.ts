import type { SessionData, TerminalSession, WorkspaceState } from '@shared/types/ipc.types'
import { useEffect, useRef } from 'react'
import { sessionApi } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'

const SESSION_SAVE_DEBOUNCE_MS = 2000
const SESSION_SAVE_INTERVAL_MS = 15000

function toTerminalSession(
  terminal: ReturnType<typeof useTerminalStore.getState>['terminals'][number]
): TerminalSession {
  return {
    id: terminal.id,
    shell: terminal.shell,
    cwd: terminal.cwd ?? '',
    history: terminal.pendingScrollback ?? terminal.transcript?.split(/\r\n|\r|\n/) ?? [],
    env: undefined
  }
}

function buildSessionData(): SessionData {
  const projectState = useProjectStore.getState()
  const terminalState = useTerminalStore.getState()

  return {
    timestamp: new Date().toISOString(),
    terminals: terminalState.terminals.map(toTerminalSession),
    workspaces: projectState.projects.map<WorkspaceState>((project) => {
      const projectTerminals = terminalState.terminals.filter(
        (terminal) => terminal.projectId === project.id
      )
      const activeTerminal =
        projectTerminals.find((terminal) => terminal.id === terminalState.activeTerminalId) ??
        projectTerminals.find((terminal) => terminal.ptyId) ??
        projectTerminals[0] ??
        null

      return {
        projectId: project.id,
        activeTerminalId: activeTerminal?.id ?? null,
        terminals: projectTerminals.map(toTerminalSession)
      }
    })
  }
}

export function useSessionRecovery(): void {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false

    const flushSession = async (): Promise<void> => {
      if (cancelled) return
      const result = await sessionApi.save(buildSessionData())
      if (!result.success) {
        console.error('Failed to persist crash recovery session:', result.error)
      }
    }

    const scheduleSave = (): void => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        void flushSession()
      }, SESSION_SAVE_DEBOUNCE_MS)
    }

    const unsubscribeProject = useProjectStore.subscribe(scheduleSave)
    const unsubscribeTerminal = useTerminalStore.subscribe(scheduleSave)

    intervalRef.current = setInterval(() => {
      void flushSession()
    }, SESSION_SAVE_INTERVAL_MS)

    void flushSession()

    return () => {
      void flushSession()
      unsubscribeProject()
      unsubscribeTerminal()
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      if (intervalRef.current) clearInterval(intervalRef.current)
      cancelled = true
    }
  }, [])
}
