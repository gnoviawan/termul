/**
 * Shared contracts of the project-switch coordinator (AD-13).
 */

import type { PersistedPaneNodeInput } from '@/hooks/editor-persistence/types'
import type { EditorFileState } from '@/stores/editor-store'
import { createProjectWorkspace, type ProjectWorkspace } from '@/stores/workspace-store'

/**
 * Everything a switch needs to show a project, built OFF-store and applied in
 * one synchronous commit. `tree: null` means "the project already has a
 * parked tree — keep it" (editor state is still staged: the editor store is
 * one global store swapped on every switch).
 */
export interface StagedProject {
  tree: ProjectWorkspace | null
  editorFiles: Map<string, EditorFileState>
  activeFilePath: string | null
  /** Expanded explorer dirs to apply; null leaves the explorer untouched. */
  expandedDirs: string[] | null
  /** Persisted legacy layout, consumed by the chat reattach on commit. */
  persistedLayout: PersistedPaneNodeInput | undefined
}

/** A degraded-but-valid staging: a fresh single-leaf workspace and no files. */
export function emptyStagedProject(): StagedProject {
  return {
    tree: createProjectWorkspace(),
    editorFiles: new Map(),
    activeFilePath: null,
    expandedDirs: null,
    persistedLayout: undefined
  }
}

export type SwitchStatus =
  | { kind: 'idle' }
  | { kind: 'pending'; projectId: string }
  | { kind: 'failed'; projectId: string; message: string }

/**
 * `committed`: the project's tree is now the visible one. `noop`: the target
 * was already committed. `superseded`: a newer request (or the user moving
 * away) won. `cancelled`: the coordinator was disposed. `failed`: the switch
 * threw and was rolled back.
 */
export type SwitchOutcome = 'committed' | 'noop' | 'superseded' | 'cancelled' | 'failed'

export interface SwitchRequest {
  /**
   * `pick`: the user/project-store chose the project (driven by an effect, so
   * it may repeat). `open`: an explicit open of something inside the project;
   * `afterCommit` runs once the project's tree is visible, and the request is
   * dropped if the focused pane changes meanwhile.
   */
  kind: 'pick' | 'open'
  projectId: string
  afterCommit?: () => void
}

export interface SwitchToken {
  id: number
  projectId: string
  /** Only `open` requests pin the focused pane. */
  focusedPaneId?: string
}

export interface SwitchDeps {
  /** Project whose tree is visible (workspace store `activeProjectId`); '' before the first commit. */
  getCommittedProjectId: () => string
  /** The project the user last chose (project-store intent). */
  getActiveProjectId: () => string
  getFocusedPaneId: () => string
  /** True when the project has a visible or parked tree. */
  hasTree: (projectId: string) => boolean
  /** Flush editor work, persist the leaving project's state, retain its visible chats. */
  leave: (fromProjectId: string) => Promise<void>
  /** Build a project that has no tree yet, off-store. */
  hydrate: (projectId: string, isCurrent: () => boolean) => Promise<StagedProject>
  /** Stage only the editor state of a project that already has a tree (`tree: null`). */
  hydrateEditor: (projectId: string, isCurrent: () => boolean) => Promise<StagedProject>
  /** Apply the staged project synchronously and atomically. */
  commit: (projectId: string, staged: StagedProject) => void
  /** First non-archived project ('' when none). */
  landingProjectId: () => string
  /** Select that project in the project store (intent follows the committed project). */
  revertTo: (projectId: string) => void
  setStatus: (status: SwitchStatus) => void
}
