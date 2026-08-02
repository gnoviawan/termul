import type { SessionData, TerminalSession, WorkspaceState } from '@shared/types/ipc.types'
import { useEffect, useRef } from 'react'
import { sessionApi } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { getTerminalModes } from '@/utils/terminal-registry'

const SESSION_SAVE_DEBOUNCE_MS = 2000
const SESSION_SAVE_INTERVAL_MS = 15000

export function toTerminalSession(
  terminal: ReturnType<typeof useTerminalStore.getState>['terminals'][number]
): TerminalSession {
  // R3: best-effort capture of the tracked DEC private-mode snapshot
  // (keyed by the same registry id as extractScrollback: ptyId ?? id).
  // Absence (no tracker / terminal not live) degrades to content-only restore.
  const modes = getTerminalModes(terminal.ptyId ?? terminal.id)
  return {
    id: terminal.id,
    shell: terminal.shell,
    cwd: terminal.cwd ?? '',
    history: terminal.pendingScrollback ?? terminal.transcript?.split(/\r\n|\r|\n/) ?? [],
    env: undefined,
    ...(modes ? { modes } : {})
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
