import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'
import { worktreeApi } from '@/lib/worktree-api'
import { reconcileProjectWorktrees, worktreeKey } from '@/lib/worktree-reconciler'
import { useProjectStore } from '@/stores/project-store'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'

/** Isolation mode selected in the launcher context strip. */
export type LaunchIsolationMode = 'current' | 'worktree'

export interface PrepareLaunchWorktreeInput {
  isolationMode: LaunchIsolationMode
  canUseWorktree: boolean
  baseBranch: string | null
  projectRoot: string
  projectId: string
  /**
   * Correlation id for the in-timeline worktree-creation progress card. When
   * set, git's `worktree add` stderr lines stream into
   * `useWorktreeProgressStore` (Tauri event / web NDJSON stream), and the
   * card's `copying`/`complete` phases are driven from here.
   */
  progressId?: string
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

  const progressId = input.progressId
  const progressStore = progressId ? useWorktreeProgressStore.getState() : null

  const chatId = randomUUID().slice(0, 8)
  const branchName = `chat/${chatId}`
  if (progressId) progressStore?.begin(progressId, branchName)
  const createResult = await worktreeApi.create({
    projectPath: projectRoot,
    name: chatId,
    branch: branchName,
    isNewBranch: true,
    startRef: baseBranch,
    progressId,
    onProgress: progressStore?.handleEvent
  })
  let worktreePathResult: string | null =
    createResult.success && createResult.data ? createResult.data.path : null
  let worktreeBranchResult: string = branchName
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
      // Fresh `begin` resets the card (branch label + step states) for the
      // collision retry; the failed first attempt's lines are discarded.
      if (progressId) progressStore?.begin(progressId, retryBranch)
      const retryResult = await worktreeApi.create({
        projectPath: projectRoot,
        name: retryId,
        branch: retryBranch,
        isNewBranch: true,
        startRef: baseBranch,
        progressId,
        onProgress: progressStore?.handleEvent
      })
      if (retryResult.success && retryResult.data) {
        worktreePathResult = retryResult.data.path
        worktreeBranchResult = retryBranch
      } else {
        const retryCode = retryResult.success ? 'UNKNOWN' : retryResult.code
        const retryErr = retryResult.success ? 'unknown' : retryResult.error
        void logFrontendError({
          level: 'warn',
          source: 'agentLauncher.worktreeCreate',
          message: `worktree create retry failed name=${retryId} code=${retryCode} branch=${retryBranch}: ${retryErr}`
        })
        if (progressId) {
          progressStore?.finish(progressId, `Worktree creation failed: ${retryErr}`)
        }
        throw new Error(`Worktree creation failed: ${retryErr}`)
      }
    } else {
      const createErr = createResult.success ? 'unknown' : createResult.error
      void logFrontendError({
        level: 'warn',
        source: 'agentLauncher.worktreeCreate',
        message: `worktree create failed name=${chatId} code=${failCode} branch=${branchName}: ${createErr}`
      })
      if (progressId) {
        progressStore?.finish(progressId, `Worktree creation failed: ${createErr}`)
      }
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
  if (progressId) progressStore?.appendLine(progressId, 'Copying .worktree-include files…')
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

  // Register the just-created worktree through the single-flight reconciler
  // (the only writer of `project.worktrees`) and activate it so the Chats
  // sidebar scopes to it immediately (no 60s reconciler wait) and the worktree
  // survives across restarts. Best-effort: a failure logs a warn and the chat
  // still opens below.
  try {
    await reconcileProjectWorktrees(projectId)
    const projectStore = useProjectStore.getState()
    const resultKey = worktreeKey(worktreePathResult)
    const stored = projectStore.projects
      .find((p) => p.id === projectId)
      ?.worktrees?.find((w) => worktreeKey(w.path) === resultKey)
    if (stored) {
      projectStore.setActiveWorktree(projectId, stored.id)
      // Boundary log (info-level): not an error, so console.info is
      // appropriate (logFrontendError is error/warn only).
      console.info(
        `[agentLauncher.worktreeRegister] activated branch=${worktreeBranchResult} path=${worktreePathResult}`
      )
    } else {
      void logFrontendError({
        level: 'warn',
        source: 'agentLauncher.worktreeRegister',
        message: `created worktree not found after reconcile branch=${worktreeBranchResult} path=${worktreePathResult}`
      })
    }
  } catch (registerErr) {
    void logFrontendError({
      level: 'warn',
      source: 'agentLauncher.worktreeRegister',
      message: `register/activate failed: ${registerErr instanceof Error ? registerErr.message : String(registerErr)}`
    })
  }

  if (progressId) progressStore?.finish(progressId)

  return {
    launchCwd: worktreePathResult,
    worktreePath: worktreePathResult,
    worktreeBranch: worktreeBranchResult
  }
}
