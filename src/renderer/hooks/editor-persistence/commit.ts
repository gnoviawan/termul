/**
 * The synchronous half of a project switch: apply a {@link StagedProject}
 * built by `hydrateProject` to the live stores in one go. Runs only from the
 * coordinator, right after its final `isCurrent()` check, so nothing here may
 * await before the stores are consistent.
 */

import { scheduleAutoSave } from '@/lib/editor-auto-save'
import type { StagedProject } from '@/lib/project-switch/types'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { reattachOpenAgentChats, retainVisibleAgentChats } from './chat-restore'
import { persistState } from './persist'

export function commitStagedProject(projectId: string, staged: StagedProject): void {
  // The project being left stayed visible (and editable) while the target
  // hydrated, and `leave()` persisted it BEFORE that window. Persist it again
  // synchronously, before the editor store is cleared, so edits made in the
  // window are not lost with the buffers (both calls are idempotent).
  const leaving = useWorkspaceStore.getState().activeProjectId
  if (leaving && leaving !== projectId) {
    retainVisibleAgentChats(leaving)
    persistState(leaving)
  }

  // Editor files (one global store swapped per switch): clear cancels the
  // leaving project's pending autosaves, then the staged map goes in whole.
  const editor = useEditorStore.getState()
  editor.clearAllFiles()
  useEditorStore.setState({
    openFiles: staged.editorFiles,
    activeFilePath: staged.activeFilePath
  })
  // A restored unsaved draft is autosaved exactly as `updateContent` did when
  // the restore replayed it through the store.
  for (const [filePath, file] of staged.editorFiles) {
    if (file.isDirty) scheduleAutoSave(filePath)
  }

  const explorer = useFileExplorerStore.getState()
  if (staged.expandedDirs) explorer.setExpandedDirs(new Set(staged.expandedDirs))

  const workspace = useWorkspaceStore.getState()
  workspace.activateProject(projectId, staged.tree ?? undefined)
  // The launcher overlay of the project just left (or of a parked tree) must
  // not reappear; WorkspaceLayout treats a tracked launcher pane as open.
  useWorkspaceStore.getState().hideAgentLauncher()

  // A parked tree was last reconciled when it was left; use-terminal-tab-sync
  // skips its sync on a project change, so reconcile against the project's
  // live terminals here.
  if (staged.tree === null) {
    const terminalIds = useTerminalStore
      .getState()
      .terminals.filter((terminal) => terminal.projectId === projectId)
      .map((terminal) => terminal.id)
    useWorkspaceStore.getState().syncTerminalTabs(terminalIds)
  }

  // Chats reattach after the tree is visible (idempotent for a visited tree).
  reattachOpenAgentChats(projectId, staged.persistedLayout)

  // Expanded dirs load asynchronously; skip when the user already moved on.
  const expandedDirs = staged.expandedDirs
  if (expandedDirs && expandedDirs.length > 0) {
    const stillCurrent = (): boolean =>
      useWorkspaceStore.getState().activeProjectId === projectId &&
      useProjectStore.getState().activeProjectId === projectId
    if (stillCurrent()) void useFileExplorerStore.getState().restoreExpandedDirs(expandedDirs)
  }
}
