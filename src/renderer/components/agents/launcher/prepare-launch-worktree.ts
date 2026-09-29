import { normalizeCwdForScope } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'
import { worktreeApi } from '@/lib/worktree-api'
import { useProjectStore } from '@/stores/project-store'
import type { Worktree } from '@/types/project'

/** Isolation mode selected in the launcher context strip. */
export type LaunchIsolationMode = 'current' | 'worktree'

export interface PrepareLaunchWorktreeInput {
  isolationMode: LaunchIsolationMode
  canUseWorktree: boolean
  baseBranch: string | null
  projectRoot: string
  projectId: string
}

export interface PrepareLaunchWorktreeResult {
  launchCwd: string
  worktreePath?: string
  worktreeBranch?: string
}

/**
 * Create and register a launch worktree when New worktree is selected.
 * Local mode returns the project root unchanged.
 *
 * CAP-3: the isolated worktree exists before the chat opens so the agent cwd
 * is the worktree path from the first turn. Branch is `chat/{id}`
 * (deterministic, id-scoped). Collision-retry appends `-2` once.
 */
export async function prepareLaunchWorktree(
  input: PrepareLaunchWorktreeInput
): Promise<PrepareLaunchWorktreeResult> {
  const { isolationMode, canUseWorktree, baseBranch, projectRoot, projectId } = input
  if (isolationMode !== 'worktree' || !canUseWorktree) {
    return { launchCwd: projectRoot }
  }
  if (!baseBranch) {
    throw new Error('Pick a base branch for the worktree')
  }

  const chatId = randomUUID().slice(0, 8)
  const branchName = `chat/${chatId}`
  const createResult = await worktreeApi.create({
    projectPath: projectRoot,
    name: chatId,
    branch: branchName,
    isNewBranch: true,
    startRef: baseBranch
  })
  let worktreePathResult: string | null =
    createResult.success && createResult.data ? createResult.data.path : null
  let worktreeBranchResult: string = branchName
  // Track the worktree NAME actually used (the retry branch appends `-2`),
  // so the project-store entry's `name` matches the git worktree on disk.
  let worktreeNameResult: string = chatId
  if (!worktreePathResult) {
    const failCode = createResult.success ? 'UNKNOWN' : createResult.code
    if (failCode === 'WORKTREE_EXISTS' || failCode === 'BRANCH_ALREADY_HAS_WORKTREE') {
      // Collision-retry: append `-2` suffix once (stale state from a
      // prior crashed run). Never deadlock — a second collision surfaces
      // an error.
      const retryId = `${chatId}-2`
      const retryBranch = `${branchName}-2`
      void logFrontendError({
        level: 'warn',
        source: 'agentLauncher.worktreeCreate',
        message: `collision on ${branchName}, retrying as ${retryBranch}`
      })
      const retryResult = await worktreeApi.create({
        projectPath: projectRoot,
        name: retryId,
        branch: retryBranch,
        isNewBranch: true,
        startRef: baseBranch
      })
      if (retryResult.success && retryResult.data) {
        worktreePathResult = retryResult.data.path
        worktreeBranchResult = retryBranch
        worktreeNameResult = retryId
      } else {
        const retryErr = retryResult.success ? 'unknown' : retryResult.error
        throw new Error(`Worktree creation failed: ${retryErr}`)
      }
    } else {
      const createErr = createResult.success ? 'unknown' : createResult.error
      throw new Error(`Worktree creation failed: ${createErr}`)
    }
  }

  if (!worktreePathResult) {
    return { launchCwd: projectRoot }
  }

  // CAP-5: carry over untracked files listed in `.worktree-include`.
  // Symlink/path-escape/already-present defenses run on the host.
  // Best-effort: a copy failure must not orphan the freshly created
  // worktree + branch — log and continue launching into it.
  try {
    const includeResult = await worktreeApi.copyIncludeFiles(projectRoot, worktreePathResult)
    if (!includeResult.success) {
      void logFrontendError({
        level: 'warn',
        source: 'agentLauncher.worktreeInclude',
        message: `copyIncludeFiles failed: ${includeResult.success ? '' : includeResult.error}`
      })
    } else if (includeResult.data) {
      // Boundary log (info-level): not an error, so console.info is
      // appropriate (logFrontendError is error/warn only).
      console.info(
        `[agentLauncher.worktreeInclude] carry-over ran=${includeResult.data.ran} copied=${includeResult.data.copied} skipped=${includeResult.data.skipped.length}`
      )
    }
  } catch (includeErr) {
    void logFrontendError({
      level: 'warn',
      source: 'agentLauncher.worktreeInclude',
      message: `copyIncludeFiles threw: ${includeErr instanceof Error ? includeErr.message : String(includeErr)}`
    })
  }

  // Register the just-created worktree in the project store and
  // activate it so the Chats sidebar scopes to it immediately (no
  // 60s reconciler wait) and the worktree survives across restarts.
  // Dedupe by path against already-stored worktrees so the reconciler
  // cannot add a second entry for the same path later. Best-effort:
  // a failure logs a warn and the chat still opens below.
  try {
    const projectStore = useProjectStore.getState()
    const stored = projectStore.projects.find((p) => p.id === projectId)
    // Dedupe by normalized path: worktreeApi.create and an already-stored
    // entry (from a prior launch or the reconciler's worktreeApi.list)
    // can differ by trailing slash / verbatim prefix. Without
    // normalization the dedup misses and addWorktree creates a duplicate
    // the comment below claims to prevent.
    const alreadyStored = stored?.worktrees?.find(
      (w) => normalizeCwdForScope(w.path) === normalizeCwdForScope(worktreePathResult)
    )
    if (alreadyStored) {
      projectStore.setActiveWorktree(projectId, alreadyStored.id)
    } else {
      const newWorktree: Worktree = {
        id: randomUUID(),
        name: worktreeNameResult,
        branch: worktreeBranchResult,
        path: worktreePathResult,
        createdAt: new Date().toISOString()
      }
      projectStore.addWorktree(projectId, newWorktree)
      projectStore.setActiveWorktree(projectId, newWorktree.id)
    }
    // Boundary log (info-level): not an error, so console.info is
    // appropriate (logFrontendError is error/warn only).
    console.info(
      `[agentLauncher.worktreeRegister] activated branch=${worktreeBranchResult} path=${worktreePathResult}`
    )
  } catch (registerErr) {
    void logFrontendError({
      level: 'warn',
      source: 'agentLauncher.worktreeRegister',
      message: `register/activate failed: ${registerErr instanceof Error ? registerErr.message : String(registerErr)}`
    })
  }

  return {
    launchCwd: worktreePathResult,
    worktreePath: worktreePathResult,
    worktreeBranch: worktreeBranchResult
  }
}
