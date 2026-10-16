/**
 * Off-store hydration for the project-switch coordinator: replicates the read
 * path of the old in-hook restore (the project's workspace record, open files,
 * pane layout) but writes NOTHING to any store. The result
 * is a {@link StagedProject} the coordinator commits atomically once it is
 * still the latest request; `isCurrent()` is checked after every await so a
 * superseded hydration stops early (its return value is then discarded).
 */

import { loadPersistedTerminals } from '@/hooks/useTerminalAutoSave'
import { filesystemApi, persistenceApi } from '@/lib/api'
import { emptyStagedProject, type StagedProject } from '@/lib/project-switch/types'
import type { EditorFileState } from '@/stores/editor-store'
import { detectLanguage, getDefaultViewMode, reconcileDraft } from '@/stores/editor-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  buildProjectWorkspace,
  createProjectWorkspace,
  editorTabId,
  type ProjectWorkspace
} from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'
import { deserializePaneTree, reconcileTerminalTabs } from './pane-tree'
import {
  editorStateKey,
  filterExpandedDirsByRoot,
  type PersistedEditorFile,
  type PersistedEditorState
} from './types'

export type { StagedProject } from '@/lib/project-switch/types'

/** Read one file into a staged editor state; a deleted/unreadable file yields null. */
async function stageFile(filePath: string): Promise<EditorFileState | null> {
  try {
    const result = await filesystemApi.readFile(filePath)
    if (!result.success) return null
    return {
      filePath,
      content: result.data.content,
      originalContent: result.data.content,
      isDirty: false,
      language: detectLanguage(filePath),
      lastModified: result.data.modifiedAt,
      viewMode: getDefaultViewMode(filePath),
      cursorPosition: { line: 1, col: 1 },
      scrollTop: 0,
      operationStatus: 'idle'
    }
  } catch {
    // File may have been deleted since last session.
    return null
  }
}

/**
 * Apply a persisted unsaved draft to the freshly read file: the draft wins when
 * the file on disk is not newer than the draft; a newer file shows a conflict.
 */
function applyPersistedDraft(
  file: EditorFileState,
  persisted: PersistedEditorFile
): EditorFileState {
  if (!persisted.isDirty || !persisted.draftContent) return file
  return reconcileDraft(file, { content: persisted.draftContent, savedAt: persisted.lastModified })
}

function applyPersistedViewState(
  file: EditorFileState,
  persisted: PersistedEditorFile
): EditorFileState {
  return applyPersistedDraft(
    {
      ...file,
      cursorPosition: { line: persisted.cursorPosition.line, col: persisted.cursorPosition.col },
      scrollTop: persisted.scrollTop,
      viewMode: persisted.viewMode !== 'code' ? persisted.viewMode : file.viewMode
    },
    persisted
  )
}

/** Fresh single-leaf layout carrying the open files as tabs (legacy, pre-paneLayout state). */
function legacyEditorWorkspace(
  filePaths: string[],
  restoredActiveTabId: string | null
): ProjectWorkspace {
  const fresh = createProjectWorkspace()
  const tabs = [...new Set(filePaths)].map((filePath) => ({
    type: 'editor' as const,
    id: editorTabId(filePath),
    filePath
  }))
  let activeTabId = restoredActiveTabId
  if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null
  }
  const leaf: LeafNode = { ...(fresh.root as LeafNode), tabs, activeTabId }
  return { ...fresh, root: leaf }
}

/**
 * Build everything needed to show `projectId`. `withTree: false` is for a
 * project that already has a parked tree: only its editor state is staged
 * (`tree: null`).
 */
export async function hydrateProject(
  projectId: string,
  isCurrent: () => boolean,
  options: { withTree?: boolean } = {}
): Promise<StagedProject> {
  const withTree = options.withTree !== false
  const abandoned = emptyStagedProject()

  const result = await persistenceApi.read<PersistedEditorState>(editorStateKey(projectId))
  if (!isCurrent()) return abandoned

  if (!result.success || !result.data) {
    // Nothing stored for this project on this device: a fresh workspace.
    return withTree ? emptyStagedProject() : { ...emptyStagedProject(), tree: null }
  }

  const persisted = result.data
  const rootPath = useProjectStore
    .getState()
    .projects.find((project) => project.id === projectId)?.path
  const expandedDirs = filterExpandedDirsByRoot(persisted.expandedDirs, rootPath)

  const read = await Promise.all(persisted.openFiles.map((file) => stageFile(file.filePath)))
  if (!isCurrent()) return abandoned
  const editorFiles = new Map<string, EditorFileState>()
  persisted.openFiles.forEach((file, index) => {
    const staged = read[index]
    if (staged) editorFiles.set(file.filePath, applyPersistedViewState(staged, file))
  })

  if (!withTree) {
    return {
      tree: null,
      editorFiles,
      activeFilePath: persisted.activeFilePath,
      expandedDirs,
      persistedLayout: persisted.paneLayout
    }
  }

  let tree: ProjectWorkspace
  if (persisted.paneLayout) {
    const liveProjectTerminals = useTerminalStore
      .getState()
      .terminals.filter((terminal) => terminal.projectId === projectId && !!terminal.ptyId)
    const persistedTerminalLayout = await loadPersistedTerminals(projectId)
    if (!isCurrent()) return abandoned

    const restoredTree = deserializePaneTree(persisted.paneLayout)
    const cleanTree = reconcileTerminalTabs(
      restoredTree,
      new Set(editorFiles.keys()),
      liveProjectTerminals,
      persistedTerminalLayout
    )
    tree = buildProjectWorkspace(cleanTree, persisted.activePaneId)
  } else {
    tree = legacyEditorWorkspace([...editorFiles.keys()], persisted.activeTabId)
  }

  return {
    tree,
    editorFiles,
    activeFilePath: persisted.activeFilePath,
    expandedDirs,
    persistedLayout: persisted.paneLayout
  }
}
