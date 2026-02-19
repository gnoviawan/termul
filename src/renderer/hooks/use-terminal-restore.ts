import { useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/project-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useAppSettingsStore } from '../stores/app-settings-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import {
  loadPersistedTerminals,
  saveTerminalLayout,
  setTerminalRestoreInProgress
} from './useTerminalAutoSave'
import type { PersistedTerminalLayout } from '../../shared/types/persistence.types'

/**
 * Hook to restore terminals when switching projects
 * Loads persisted terminal layout and creates terminal instances
 */
export function useTerminalRestore(): void {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const previousProjectIdRef = useRef<string>('')
  const isRestoringRef = useRef(false)

  useEffect(() => {
    // Skip if no project selected or same project
    if (!activeProjectId || activeProjectId === previousProjectIdRef.current) {
      return
    }

    // Skip if already restoring
    if (isRestoringRef.current) {
      return
    }

    const restoreTerminals = async (): Promise<void> => {
      isRestoringRef.current = true
      setTerminalRestoreInProgress(true)
      const projectIdToRestore = activeProjectId

      try {
        // Save previous project's terminal state before switching
        const previousProjectId = previousProjectIdRef.current
        if (previousProjectId) {
          await saveTerminalLayout(previousProjectId)
        }

        // Get fresh state after save completes
        const terminalStore = useTerminalStore.getState()
        const existingTerminals = terminalStore.terminals.filter(
          (t) => t.projectId === projectIdToRestore
        )

        // If terminals already exist in memory, just restore selection
        if (existingTerminals.length > 0) {
          const layout = await loadPersistedTerminals(projectIdToRestore)
          selectTerminalForProject(projectIdToRestore, existingTerminals, layout)
          return
        }

        // No terminals in memory - load from disk or create default
        const layout = await loadPersistedTerminals(projectIdToRestore)

        if (layout && layout.terminals.length > 0) {
          restoreFromLayout(projectIdToRestore, layout)
        } else {
          createDefaultTerminal(projectIdToRestore)
        }
      } catch (err: unknown) {
        console.error('Failed to restore terminals:', err)
        // Fall back to default terminal
        createDefaultTerminal(projectIdToRestore)
      } finally {
        isRestoringRef.current = false
        setTerminalRestoreInProgress(false)
        previousProjectIdRef.current = projectIdToRestore
      }
    }

    restoreTerminals()
  }, [activeProjectId])
}

/**
 * Select the appropriate terminal for a project
 * Uses multiple matching strategies: ID match, then name match, then fallback
 */
function selectTerminalForProject(
  projectId: string,
  existingTerminals: Array<{ id: string; name: string; projectId: string }>,
  layout: PersistedTerminalLayout | null
): void {
  if (existingTerminals.length === 0) {
    return
  }

  const terminalStore = useTerminalStore.getState()
  let terminalIdToSelect: string | null = null

  if (layout?.activeTerminalId) {
    // Strategy 1: Direct ID match (terminals stayed in memory with same IDs)
    const directMatch = existingTerminals.find(
      (t) => t.id === layout.activeTerminalId
    )
    if (directMatch) {
      terminalIdToSelect = directMatch.id
    } else {
      // Strategy 2: Match by name (IDs regenerated but names preserved)
      const persistedActive = layout.terminals.find(
        (pt) => pt.id === layout.activeTerminalId
      )
      if (persistedActive) {
        const nameMatch = existingTerminals.find(
          (t) => t.name === persistedActive.name
        )
        if (nameMatch) {
          terminalIdToSelect = nameMatch.id
        }
      }
    }
  }

  // Fallback: select first terminal for this project
  if (!terminalIdToSelect) {
    terminalIdToSelect = existingTerminals[0].id
  }

  // Always select a terminal - ensures the project has an active terminal
  terminalStore.selectTerminal(terminalIdToSelect)
}

/**
 * Restore terminals from persisted layout (only when no terminals exist in memory)
 */
function restoreFromLayout(projectId: string, layout: PersistedTerminalLayout): void {
  const terminalStore = useTerminalStore.getState()

  // Create all terminals at once to avoid multiple re-renders
  const newTerminals: Array<{
    id: string
    name: string
    projectId: string
    shell: string
    cwd?: string
    output: never[]
    pendingScrollback?: string[]
  }> = []

  // Map old IDs to new IDs for active terminal selection and pane remapping
  const idMap = new Map<string, string>()

  for (const persistedTerminal of layout.terminals) {
    const newId = Date.now().toString() + Math.random().toString(36).slice(2, 5)
    idMap.set(persistedTerminal.id, newId)
    newTerminals.push({
      id: newId,
      name: persistedTerminal.name,
      projectId,
      shell: persistedTerminal.shell || 'powershell',
      cwd: persistedTerminal.cwd,
      output: [],
      pendingScrollback: persistedTerminal.scrollback
    })
  }

  // Add all terminals at once
  const existingTerminals = terminalStore.terminals
  terminalStore.setTerminals([...existingTerminals, ...newTerminals])

  if (idMap.size > 0) {
    useWorkspaceStore.getState().remapTerminalTabs(Object.fromEntries(idMap))
  }

  // Determine which terminal should be active
  let activeId = newTerminals[0]?.id || ''
  if (layout.activeTerminalId && idMap.has(layout.activeTerminalId)) {
    activeId = idMap.get(layout.activeTerminalId)!
  }

  // Select the active terminal
  if (activeId) {
    terminalStore.selectTerminal(activeId)
  }
}

/**
 * Create a default terminal when no persisted data exists
 */
function createDefaultTerminal(projectId: string): void {
  const terminalStore = useTerminalStore.getState()
  const projectStore = useProjectStore.getState()
  const appSettings = useAppSettingsStore.getState()

  // Check if project already has terminals (shouldn't happen, but be safe)
  const existingTerminals = terminalStore.terminals.filter((t) => t.projectId === projectId)
  if (existingTerminals.length > 0) {
    terminalStore.selectTerminal(existingTerminals[0].id)
    return
  }

  // Get shell from fallback chain: project -> app settings -> system default
  const project = projectStore.projects.find((p) => p.id === projectId)
  const shell = project?.defaultShell || appSettings.settings.defaultShell || ''

  // Create default terminal - addTerminal also sets it as active
  const newTerminal = terminalStore.addTerminal('Terminal 1', projectId, shell, project?.path)

  // Explicitly select to ensure activeTerminalId is set correctly
  terminalStore.selectTerminal(newTerminal.id)
}
