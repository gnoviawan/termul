import { create } from 'zustand'
import { logFrontendError } from '@/lib/log-api'
import { getActiveWorktreeRoot, getProjectRootPath } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { getAllLeafPanes, useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'

/** Where the Git sheet's working directory came from (logged at open). */
export type GitSheetCwdSource = 'explicit' | 'active-chat' | 'active-worktree' | 'project'

export interface ResolveGitSheetCwdInput {
  /** A caller-supplied directory, e.g. the chat's own `session.cwd`. Wins when non-blank. */
  explicitCwd?: string | null
  /** The pane's active tab; only an `agent-chat` tab makes `sessionCwd` apply. */
  activeTab?: { type: string } | null
  /** `cwd` of the session behind the active chat tab. */
  sessionCwd?: string | null
  /** Root of the project's active worktree, or null when on the project root. */
  activeWorktreeRoot?: string | null
  /** The active project's own path. */
  projectPath?: string | null
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Pick the directory the mobile Git sheet should open on: an explicit cwd,
 * else the active chat's session cwd, else the project's active worktree root,
 * else the project path. Null when none resolve (the sheet then stays closed).
 */
export function resolveGitSheetCwd(
  input: ResolveGitSheetCwdInput
): { cwd: string; source: GitSheetCwdSource } | null {
  if (present(input.explicitCwd)) return { cwd: input.explicitCwd, source: 'explicit' }
  if (input.activeTab?.type === 'agent-chat' && present(input.sessionCwd)) {
    return { cwd: input.sessionCwd, source: 'active-chat' }
  }
  if (present(input.activeWorktreeRoot)) {
    return { cwd: input.activeWorktreeRoot, source: 'active-worktree' }
  }
  if (present(input.projectPath)) return { cwd: input.projectPath, source: 'project' }
  return null
}

interface GitSheetState {
  /** Whether the mobile Git Changes sheet is open. */
  open: boolean
  /** Directory the sheet was opened on. Snapshotted at open; kept while closing so the exit animation keeps its content. */
  cwd: string
  /** Active project id recorded at open ('' when unknown); a different active project closes the sheet. */
  projectId: string
  /** Open the sheet on `cwd`, or on the cwd `resolveGitSheetCwd` finds when omitted. */
  openGitSheet: (cwd?: string) => void
  closeGitSheet: () => void
}

/** The active tab of the active pane (mirrors the MobileChatShell selector). */
function readActiveTab(): WorkspaceTab | null {
  const { root, activePaneId } = useWorkspaceStore.getState()
  const leaves = getAllLeafPanes(root)
  const pane = leaves.find((p) => p.id === activePaneId) ?? leaves[0]
  return pane?.tabs.find((t) => t.id === pane.activeTabId) ?? null
}

/**
 * Open state for the mobile Git Changes sheet, lifted out of `WorkspaceLayout`
 * so the chat dock's changed-files bar can open it. Renderer-only: no
 * transport or backend change.
 */
export const useGitSheetStore = create<GitSheetState>((set) => ({
  open: false,
  cwd: '',
  projectId: '',

  openGitSheet: (explicitCwd): void => {
    const projectId = useProjectStore.getState().activeProjectId
    // Only read the other stores when no explicit cwd already answers.
    let resolved = resolveGitSheetCwd({ explicitCwd })
    if (!resolved) {
      const activeTab = readActiveTab()
      const sessionCwd =
        activeTab?.type === 'agent-chat'
          ? (useAcpStore.getState().sessions[activeTab.sessionId]?.cwd ?? null)
          : null
      resolved = resolveGitSheetCwd({
        activeTab,
        sessionCwd,
        activeWorktreeRoot: projectId ? getActiveWorktreeRoot(projectId) : null,
        projectPath: projectId ? getProjectRootPath(projectId) : null
      })
    }
    if (!resolved) {
      void logFrontendError({
        level: 'warn',
        source: 'git-sheet-store',
        message: `Git sheet not opened: no cwd resolved (project ${projectId || 'none'})`
      })
      return
    }
    void logFrontendError({
      level: 'info',
      source: 'git-sheet-store',
      message: `Git sheet opened from ${resolved.source} cwd`
    })
    set({ open: true, cwd: resolved.cwd, projectId })
  },

  closeGitSheet: (): void => {
    set({ open: false })
  }
}))
