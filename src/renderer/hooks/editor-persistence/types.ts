import { PersistenceKeys } from '@shared/types/persistence.types'
import type { PersistedWorkspaceTabKind } from '@/lib/workspace-tab-kinds'
import type { PaneDirection } from '@/types/workspace.types'

export interface PersistedEditorFile {
  filePath: string
  cursorPosition: { line: number; col: number }
  scrollTop: number
  viewMode: 'code' | 'markdown'
  isDirty: boolean
  draftContent?: string
  lastModified: number
}

// Serialized pane tree for persistence
interface PersistedEditorTabRef {
  type: 'editor'
  filePath: string
}

interface PersistedTerminalTabRef {
  type: 'terminal'
  terminalId: string
}

interface PersistedBrowserTabRef {
  type: 'browser'
  browserTabId: string
  url?: string
}

interface PersistedGitTabRef {
  type: 'git'
  id: string
  cwd: string
}

interface PersistedAgentChatTabRef {
  type: 'agent-chat'
  id: string
  sessionId: string
}

interface PersistedGitHistoryTabRef {
  type: 'git-history'
  id: string
  cwd: string
}

interface PersistedDiffTabRef {
  type: 'diff'
  id: string
  cwd: string
  path: string
  staged: boolean
}

export type PersistedTabRef =
  | PersistedEditorTabRef
  | PersistedTerminalTabRef
  | PersistedBrowserTabRef
  | PersistedGitTabRef
  | PersistedAgentChatTabRef
  | PersistedGitHistoryTabRef
  | PersistedDiffTabRef

// Compile-time check: the persisted ref union must cover exactly the kinds the
// traits table declares as persisted (a mismatch makes this assignment error).
type AssertTypesEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _persistedTabRefKindsMatchTraits: AssertTypesEqual<
  PersistedTabRef['type'],
  PersistedWorkspaceTabKind
> = true
void _persistedTabRefKindsMatchTraits

interface PersistedLeafNode {
  type: 'leaf'
  id: string
  tabs: PersistedTabRef[]
  activeTabId: string | null
}

interface PersistedSplitNode {
  type: 'split'
  id: string
  direction: PaneDirection
  children: PersistedPaneNode[]
  sizes: number[]
}

interface LegacyPersistedLeafNode {
  type: 'leaf'
  id: string
  editorFilePaths: string[]
  activeTabId: string | null
}

export type PersistedPaneNode = PersistedLeafNode | PersistedSplitNode

export type PersistedPaneNodeInput = PersistedPaneNode | LegacyPersistedLeafNode

export interface PersistedEditorState {
  openFiles: PersistedEditorFile[]
  activeFilePath: string | null
  expandedDirs: string[]
  activeTabId: string | null
  // v2: pane layout
  paneLayout?: PersistedPaneNodeInput
  activePaneId?: string
}

export function editorStateKey(projectId: string): string {
  return PersistenceKeys.workspace(projectId)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function filterExpandedDirsByRoot(expandedDirs: string[], rootPath?: string): string[] {
  if (!rootPath) {
    return []
  }

  const normalizedRoot = normalizePath(rootPath)
  return expandedDirs
    .map((dir) => normalizePath(dir))
    .filter((dir) => dir === normalizedRoot || dir.startsWith(`${normalizedRoot}/`))
}
