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
 * CAP-6: worktree/branch indicator shared by the composer context strip and
 * the mobile shell subtitle. Worktree chats show their `chat/*` branch (the
 * long worktree path stays on the mode tooltip). Local chats fall back to the
 * project's reactive `gitBranch`. A git project with no branch is detached.
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
  const isolationBranch = worktreeBranch ?? projectGitBranch
  const isDetachedHead = !isolationBranch && !isWorktree && projectIsGitRepo
  return { isWorktree, isolationModeLabel, isolationModeTitle, isolationBranch, isDetachedHead }
}

export interface ProjectSubtitle {
  /** Visible text: `project · branch · Local|Worktree`. */
  text: string
  /** Accessible name of the subtitle button: `project · branch, switch project`. */
  label: string
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
  const branch = isolation.isolationBranch || (isolation.isDetachedHead ? 'Detached HEAD' : null)
  if (branch) {
    return {
      text: `${projectName} · ${branch} · ${isolation.isolationModeLabel}`,
      label: `${projectName} · ${branch}, switch project`
    }
  }
  return {
    text: isolation.isWorktree ? `${projectName} · Worktree` : projectName,
    label: `${projectName}, switch project`
  }
}
