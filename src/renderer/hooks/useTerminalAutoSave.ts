import { useEffect, useRef } from 'react'
import { useTerminalStore } from '../stores/terminal-store'
import { persistenceApi } from '@/lib/api'
import { useProjectStore } from '../stores/project-store'
import type { Terminal } from '@/types/project'
import type {
  PersistedTerminal,
  PersistedTerminalLayout
} from '../../shared/types/persistence.types'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import { extractScrollback } from '../utils/terminal-registry'
import { recordTerminalContinuityEvent } from '@/lib/terminal-continuity-instrumentation'

function transcriptToScrollback(transcript?: string): string[] | undefined {
  if (!transcript) {
    return undefined
  }

  // Approximate reconstruction of rendered output from raw PTY transcript.
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  const oscSequenceRegex = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g')
  const ansiSequenceRegex = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
  const withoutOsc = transcript.replace(oscSequenceRegex, '')
  const withoutAnsi = withoutOsc.replace(ansiSequenceRegex, '')
  const normalized = withoutAnsi
    .replace(/\r\n/g, '\n')
    .replace(/([^\n])\r(?!\n)/g, '$1')
    .replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines.length > 0 ? lines : undefined
}

function mergeScrollback(snapshot?: string[], transcript?: string): string[] | undefined {
  const transcriptLines = transcriptToScrollback(transcript)

  if (transcriptLines && transcriptLines.length > 0) {
    return transcriptLines
  }

  if (snapshot && snapshot.length > 0) {
    return snapshot
  }

  return undefined
}

interface PersistedTerminalSnapshot {
  persistedTerminal: PersistedTerminal
  scrollbackExtractionAvailable: boolean
  extractedScrollbackLineCount: number
}

function toPersistedTerminalSnapshot(terminal: Terminal): PersistedTerminalSnapshot {
  const extractedScrollback = extractScrollback(terminal.ptyId ?? terminal.id)

  return {
    persistedTerminal: {
      id: terminal.id,
      name: terminal.name,
      shell: terminal.shell,
      cwd: terminal.cwd,
      scrollback: mergeScrollback(extractedScrollback, terminal.transcript),
      transcript: terminal.transcript
    },
    scrollbackExtractionAvailable: extractedScrollback !== undefined,
    extractedScrollbackLineCount: extractedScrollback?.length ?? 0
  }
}

export interface SaveTerminalLayoutOptions {
  correlationId?: string
  reason?: 'project-switch' | 'manual-save' | 'auto-save'
  targetProjectId?: string
}

const terminalRestoreProjectsInProgress = new Map<string, string>()

export function setTerminalRestoreInProgress(
  projectId: string,
  isRestoring: boolean,
  ownerId: string
): void {
  if (!projectId || !ownerId) {
    return
  }

  if (isRestoring) {
    terminalRestoreProjectsInProgress.set(projectId, ownerId)
    return
  }

  if (terminalRestoreProjectsInProgress.get(projectId) === ownerId) {
    terminalRestoreProjectsInProgress.delete(projectId)
  }
}

export function isTerminalRestoreInProgress(): boolean {
  return terminalRestoreProjectsInProgress.size > 0
}

/**
 * Sync extracted scrollback to the terminal store
 * Updates each terminal's pendingScrollback field in memory
 * Skips terminals where scrollback extraction returns undefined
 */
export function syncScrollbackToStore(terminals: PersistedTerminal[]): void {
  const store = useTerminalStore.getState()
  for (const t of terminals) {
    // Skip if scrollback is undefined (terminal not in registry)
    if (t.scrollback === undefined) continue
    store.updateTerminalScrollback(t.id, t.scrollback)
  }
}

/**
 * Serialize terminal store state for persistence
 * Includes scrollback extraction from terminal registry
 */
export function serializeTerminalsForProject(
  terminals: Terminal[],
  projectId: string,
  activeTerminalId: string
): PersistedTerminalLayout {
  const projectTerminals = terminals.filter((t) => t.projectId === projectId)

  const terminalSnapshots = projectTerminals.map((terminal) =>
    toPersistedTerminalSnapshot(terminal)
  )

  return {
    activeTerminalId: projectTerminals.find((t) => t.id === activeTerminalId)?.id ?? null,
    terminals: terminalSnapshots.map(({ persistedTerminal }) => persistedTerminal),
    updatedAt: new Date().toISOString()
  }
}

/**
 * Hook to auto-save terminal layout for the active project
 * Subscribes to terminal store changes and triggers debounced writes
 */
export function useTerminalAutoSave(): void {
  const hasInitialized = useRef(false)
  const activeProjectIdRef = useRef<string>('')
  const activeProjectId = useProjectStore((state) => state.activeProjectId)

  // Keep ref in sync with current activeProjectId
  activeProjectIdRef.current = activeProjectId

  useEffect(() => {
    // Subscribe to terminal store changes
    const unsubscribe = useTerminalStore.subscribe((state, prevState) => {
      // Skip the first state change (from restore)
      if (!hasInitialized.current) {
        hasInitialized.current = true
        return
      }

      // Only save if terminals or activeTerminalId changed
      if (
        state.terminals === prevState.terminals &&
        state.activeTerminalId === prevState.activeTerminalId
      ) {
        return
      }

      // Skip activity-only changes (hasActivity/lastActivityTimestamp)
      // These create new array refs but don't affect persisted layout
      if (state.activeTerminalId === prevState.activeTerminalId) {
        const hasStructuralChange =
          state.terminals.some((t, i) => {
            const prev = prevState.terminals[i]
            if (!prev) return true
            return (
              t.id !== prev.id ||
              t.name !== prev.name ||
              t.shell !== prev.shell ||
              t.cwd !== prev.cwd ||
              t.projectId !== prev.projectId
            )
          }) || state.terminals.length !== prevState.terminals.length

        if (!hasStructuralChange) {
          return
        }
      }

      if (isTerminalRestoreInProgress()) {
        return
      }

      // Only save if we have an active project (use ref to avoid stale closure)
      const projectId = activeProjectIdRef.current
      if (!projectId) {
        return
      }

      const layout = serializeTerminalsForProject(
        state.terminals,
        projectId,
        state.activeTerminalId
      )

      // Sync layout.terminals scrollback to the in-memory store's pendingScrollback.
      // This ensures extractScrollback() values survive xterm disposal during project switches,
      // preserving scrollback in memory so it can be restored when switching back.
      syncScrollbackToStore(layout.terminals)

      // Use debounced write via API
      persistenceApi
        .writeDebounced(PersistenceKeys.terminals(projectId), layout)
        .catch((err: unknown) => {
          console.error('Failed to auto-save terminal layout:', err)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

/**
 * Load persisted terminals for a project
 * Returns null if no persisted data exists
 */
export async function loadPersistedTerminals(
  projectId: string
): Promise<PersistedTerminalLayout | null> {
  const result = await persistenceApi.read<PersistedTerminalLayout>(
    PersistenceKeys.terminals(projectId)
  )

  if (result.success) {
    return result.data
  }

  // FILE_NOT_FOUND is expected for new projects
  if (result.code === 'FILE_NOT_FOUND') {
    return null
  }

  console.error('Failed to load terminal layout:', result.error)
  return null
}

/**
 * Manually trigger a save of the current terminal layout
 * Useful for ensuring save before app quit
 */
export async function saveTerminalLayout(
  projectId: string,
  options?: SaveTerminalLayoutOptions
): Promise<void> {
  const state = useTerminalStore.getState()
  const projectTerminals = state.terminals.filter((terminal) => terminal.projectId === projectId)
  const terminalSnapshots = projectTerminals.map((terminal) => ({
    terminal,
    snapshot: toPersistedTerminalSnapshot(terminal)
  }))
  const layout: PersistedTerminalLayout = {
    activeTerminalId: projectTerminals.find((terminal) => terminal.id === state.activeTerminalId)?.id ?? null,
    terminals: terminalSnapshots.map(({ snapshot }) => snapshot.persistedTerminal),
    updatedAt: new Date().toISOString()
  }

  if (options?.reason === 'project-switch') {
    for (const { terminal, snapshot } of terminalSnapshots) {
      recordTerminalContinuityEvent({
        name: 'transcript-persistence-evaluated',
        correlationId: options.correlationId,
        projectId,
        terminalId: terminal.id,
        ptyId: terminal.ptyId,
        details: {
          reason: options.reason,
          targetProjectId: options.targetProjectId,
          transcriptLength: terminal.transcript?.length ?? 0,
          scrollbackExtractionAvailable: snapshot.scrollbackExtractionAvailable,
          extractedScrollbackLineCount: snapshot.extractedScrollbackLineCount,
          persistedScrollbackLineCount: snapshot.persistedTerminal.scrollback?.length ?? 0
        }
      })
    }
  }

  // Sync layout.terminals scrollback to the in-memory store's pendingScrollback.
  // This preserves scrollback across project switches by updating the store before
  // the xterm instance is disposed, avoiding state loss when switching projects.
  syncScrollbackToStore(layout.terminals)

  const result = await persistenceApi.write(PersistenceKeys.terminals(projectId), layout)

  if (!result.success) {
    console.error('Failed to save terminal layout:', result.error)
  }
}
