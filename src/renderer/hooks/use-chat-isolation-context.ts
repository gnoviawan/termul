import { useProjectStore } from '@/stores/project-store'

export interface ChatIsolationInput {
  /** Owning project id; unknown or missing ids resolve like a non-git project. */
  projectId: string | undefined
  /** Set when the chat runs in its own git worktree. */
  worktreePath?: string
  /** The worktree's `chat/*` branch, when the session recorded it. */
  worktreeBranch?: string
}

export interface ChatIsolationContext {
  isWorktree: boolean
  isolationModeLabel: 'Worktree' | 'Local'
  isolationModeTitle: string
  isolationBranch: string | null
  isDetachedHead: boolean
}

/**
 * CAP-6: worktree/branch indicator shared by the composer context strip, the
 * mobile shell subtitle and the drawer project row. Worktree chats show their
 * `chat/*` branch (the long worktree path stays on the mode tooltip). Local
 * chats fall back to the project's reactive `gitBranch`. A git project with no
 * branch is detached.
 */
export function useChatIsolationContext({
  projectId,
  worktreePath,
  worktreeBranch
}: ChatIsolationInput): ChatIsolationContext {
  const projectGitBranch = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.gitBranch ?? null
  )
  const projectIsGitRepo = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.isGitRepo ?? false
  )
  const isWorktree = Boolean(worktreePath)
  const isolationModeLabel = isWorktree ? 'Worktree' : 'Local'
  const isolationModeTitle = isWorktree
    ? `Agent works in a separate git worktree: ${worktreePath}`
    : 'Agent edits files in your project folder directly'
  // A worktree chat never falls back to the project branch: the agent is not on it.
  const isolationBranch = isWorktree ? (worktreeBranch ?? null) : projectGitBranch
  const isDetachedHead = !isolationBranch && !isWorktree && projectIsGitRepo
  return { isWorktree, isolationModeLabel, isolationModeTitle, isolationBranch, isDetachedHead }
}

export interface ProjectSubtitle {
  /** Visible text: `project · branch · Local|Worktree`. */
  text: string
  /** Accessible name of the subtitle button: `project · branch, switch project`. */
  label: string
}

/** The branch a git project shows: its own, or "Detached HEAD"; null when there is none to show. */
function describeIsolationBranch(isolation: ChatIsolationContext): string | null {
  return isolation.isolationBranch || (isolation.isDetachedHead ? 'Detached HEAD' : null)
}

/**
 * The isolation detail line shown under a project name: `branch · Local|Worktree`
 * for a git project (a detached HEAD reads "Detached HEAD"), `Worktree` alone
 * for a worktree chat with an unknown branch, null for a non-git project.
 */
export function describeIsolationDetail(isolation: ChatIsolationContext): string | null {
  const branch = describeIsolationBranch(isolation)
  if (branch) return `${branch} · ${isolation.isolationModeLabel}`
  return isolation.isWorktree ? 'Worktree' : null
}

/**
 * Subtitle under the mobile header title. A git project shows its branch (or
 * "Detached HEAD") and the isolation label; a worktree chat with an unknown
 * branch shows just "Worktree"; a non-git project shows only its name; no
 * project shows "No project". The accessible name drops the isolation label.
 */
export function describeProjectSubtitle(
  projectName: string | undefined,
  isolation: ChatIsolationContext
): ProjectSubtitle {
  if (!projectName) return { text: 'No project', label: 'No project, switch project' }
  const detail = describeIsolationDetail(isolation)
  const branch = describeIsolationBranch(isolation)
  return {
    text: detail ? `${projectName} · ${detail}` : projectName,
    label: branch ? `${projectName} · ${branch}, switch project` : `${projectName}, switch project`
  }
}
