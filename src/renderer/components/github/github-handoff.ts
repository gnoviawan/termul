import type {
  GithubCheckLog,
  GithubCheckoutPrResult,
  GithubChecksResult,
  GithubItemDetail,
  GithubReviewThread
} from '@shared/types/github.types'
import { type LastSelectedAgent, PersistenceKeys } from '@shared/types/persistence.types'
import { toast } from 'sonner'
import {
  type LaunchCheckout,
  type LaunchFirstTurn,
  launchChat,
  rollbackLaunchPlaceholder
} from '@/components/agents/launcher/launch-chat'
import { seedComposerDraft } from '@/components/chat/use-composer-draft'
import type { ContentBlock } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import { githubApi } from '@/lib/github-api'
import { checksToFetchLogs, fixCiPrompt } from '@/lib/github-handoff/fix-ci'
import { resolveCommentsPrompt } from '@/lib/github-handoff/resolve-comments'
import { reviewPrPrompt } from '@/lib/github-handoff/review'
import { startIssuePrompt } from '@/lib/github-handoff/start'
import { renderHandoffPrompt } from '@/lib/github-handoff/untrusted'
import { logFrontendError } from '@/lib/log-api'
import { openAgentChatInOwnProject } from '@/lib/open-agent-chat'
import { worktreeApi } from '@/lib/worktree-api'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import {
  type GithubHandoffAction,
  githubItemIdentity,
  hydrateGithubChatLinks,
  useGithubChatLinksStore
} from '@/stores/github-chat-links-store'
import type { GithubItemRef } from '@/stores/github-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { FORK_PUSH_BLOCKED_REASON } from './handoff-actions'

/** One hand-off, with what that action needs beyond the item. */
export type GithubHandoffRequest =
  | { action: 'start' }
  | { action: 'ask' }
  | { action: 'review' }
  | { action: 'fix_ci'; checks: GithubChecksResult }
  | { action: 'resolve_comments'; threads: GithubReviewThread[] }

export interface GithubHandoffContext {
  projectId: string
  /** The item tab's working copy: Ask and Review run there. */
  itemRef: GithubItemRef
  detail: GithubItemDetail
}

/** Ask and Review reopen their one chat per item; the others start a new chat each time. */
const REOPENED: ReadonlySet<GithubHandoffAction> = new Set(['ask', 'review'])
/** Hand-offs that work in a new worktree. */
const IN_NEW_WORKTREE: ReadonlySet<GithubHandoffAction> = new Set([
  'start',
  'fix_ci',
  'resolve_comments'
])

/** A hand-off step failed before the agent started: the chat tab is rolled back. */
class HandoffAbort extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

function log(level: 'info' | 'warn' | 'error', action: GithubHandoffAction, message: string): void {
  void logFrontendError({ level, source: `github.handoff.${action}`, message })
}

/** The agent a hand-off uses: the launcher's last pick when it is configured, else the first configured agent. */
async function handoffAgentConfigId(): Promise<string | null> {
  const configs = useAcpStore.getState().agentConfigs
  if (configs.length === 0) return null
  const saved = await persistenceApi
    .read<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent)
    .catch(() => null)
  const savedId = saved?.success && saved.data?.mode === 'acp' ? saved.data.agentId : null
  return configs.find((config) => config.id === savedId)?.id ?? configs[0].id
}

function sessionExists(sessionId: string): boolean {
  const acp = useAcpStore.getState()
  return Boolean(acp.sessions[sessionId]) || acp.sessionIndex.some((e) => e.id === sessionId)
}

async function checkoutPullRequest(
  ctx: GithubHandoffContext,
  checkout: LaunchCheckout
): Promise<GithubCheckoutPrResult> {
  const result = await githubApi.checkoutPr({
    cwd: checkout.launchCwd,
    repo: ctx.itemRef.repo,
    number: ctx.itemRef.number
  })
  if (result.success) return result.data
  throw new HandoffAbort(
    result.code === 'GH_FORK_PUSH_BLOCKED'
      ? FORK_PUSH_BLOCKED_REASON
      : `Couldn't check out the pull request: ${result.error}`,
    result.code
  )
}

async function fetchFailedLogs(
  ctx: GithubHandoffContext,
  checks: GithubChecksResult
): Promise<Map<number, GithubCheckLog>> {
  const logs = new Map<number, GithubCheckLog>()
  await Promise.all(
    checksToFetchLogs(checks).map(async (check) => {
      if (check.jobId === null) return
      const result = await githubApi.getCheckLog({
        cwd: ctx.itemRef.cwd,
        repo: ctx.itemRef.repo,
        jobId: check.jobId
      })
      if (result.success) logs.set(check.jobId, result.data)
    })
  )
  return logs
}

function textTurn(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Fix CI / Resolve comments: move the new worktree onto the PR head, then build the prompt from it. */
async function pullRequestTurn(
  ctx: GithubHandoffContext,
  request: Extract<GithubHandoffRequest, { action: 'fix_ci' | 'resolve_comments' }>,
  checkout: LaunchCheckout
): Promise<LaunchFirstTurn> {
  const { detail } = ctx
  if (request.action === 'fix_ci') {
    const [pr, logs] = await Promise.all([
      checkoutPullRequest(ctx, checkout),
      fetchFailedLogs(ctx, request.checks)
    ])
    const prompt = fixCiPrompt({ detail, checks: request.checks, logs, checkout: pr })
    return { blocks: textTurn(renderHandoffPrompt(prompt)), worktreeBranch: pr.headRefName }
  }
  const pr = await checkoutPullRequest(ctx, checkout)
  const prompt = resolveCommentsPrompt({ detail, threads: request.threads, checkout: pr })
  return { blocks: textTurn(renderHandoffPrompt(prompt)), worktreeBranch: pr.headRefName }
}

/**
 * Hand a GitHub issue or PR to an agent chat (CAP-5 to CAP-8) through the
 * shared launch path. Every chat is linked to its item; Ask and Review reopen
 * their existing chat. Start leaves its prompt as an unsent composer draft.
 * Termul never resolves threads or closes items itself.
 */
export async function runGithubHandoff(
  ctx: GithubHandoffContext,
  request: GithubHandoffRequest
): Promise<void> {
  const { projectId, itemRef, detail } = ctx
  const { action } = request
  const itemId = githubItemIdentity(detail.repo, itemRef.number)
  log('info', action, `Hand-off of ${itemId} started`)

  if (REOPENED.has(action)) {
    await hydrateGithubChatLinks(projectId)
    const existing = (useGithubChatLinksStore.getState().byProject[projectId] ?? [])
      .filter((l) => l.itemId === itemId && l.action === action && sessionExists(l.sessionId))
      .at(-1)
    if (existing) {
      openAgentChatInOwnProject(existing.sessionId, `github.handoff.${action}`)
      log('info', action, `Hand-off of ${itemId} reopened chat ${existing.sessionId}`)
      return
    }
  }

  const configId = await handoffAgentConfigId()
  if (!configId) {
    toast.error('Set up an agent first', {
      description: 'Pick an agent in the new chat launcher, then try again.'
    })
    const workspace = useWorkspaceStore.getState()
    if (workspace.activePaneId) workspace.showAgentLauncher(workspace.activePaneId)
    log('warn', action, `Hand-off of ${itemId} has no configured agent`)
    return
  }

  const projectRoot = getDefaultCwdForProject(projectId)
  let newWorktree: { projectRoot: string; baseBranch: string } | undefined
  if (IN_NEW_WORKTREE.has(action)) {
    const base = await worktreeApi.resolveBaseBranch(projectRoot)
    if (!base.success || !base.data) {
      toast.error("Couldn't find the project's default branch for a new worktree")
      log('error', action, `Hand-off of ${itemId} could not resolve a base branch`)
      return
    }
    newWorktree = { projectRoot, baseBranch: base.data.defaultBase }
  }

  const draft = action === 'start' ? renderHandoffPrompt(startIssuePrompt(detail)) : null
  const reviewTurn =
    action === 'review' && detail.pr
      ? textTurn(renderHandoffPrompt(reviewPrPrompt(detail, detail.pr)))
      : null
  let draftSeeded = false
  const seedDraft = (sessionId: string): void => {
    if (!draft || draftSeeded) return
    draftSeeded = true
    seedComposerDraft(projectId, sessionId, draft)
  }

  const links = useGithubChatLinksStore.getState()
  const { placeholderId, started } = launchChat({
    configId,
    projectId,
    checkout: { launchCwd: itemRef.cwd },
    newWorktree,
    placeholder: reviewTurn ? { initialUserBlocks: reviewTurn } : undefined,
    beforeStart: async (checkout) =>
      request.action === 'fix_ci' || request.action === 'resolve_comments'
        ? pullRequestTurn(ctx, request, checkout)
        : { blocks: reviewTurn },
    onAdopt: (from, to) => {
      links.rekey(projectId, from, to)
      seedDraft(to)
    }
  })
  links.link(projectId, {
    sessionId: placeholderId,
    action,
    itemId,
    item: { repo: detail.repo, kind: itemRef.kind, number: itemRef.number },
    createdAt: new Date().toISOString()
  })

  try {
    const sessionId = await started
    seedDraft(sessionId)
    log('info', action, `Hand-off of ${itemId} started chat ${sessionId}`)
  } catch (err) {
    if (err instanceof HandoffAbort) {
      rollbackLaunchPlaceholder(placeholderId)
      toast.error(err.message)
      log(
        'warn',
        action,
        `Hand-off of ${itemId} stopped before the agent started (code=${err.code})`
      )
      return
    }
    toast.error(err instanceof Error ? err.message : 'Failed to start the agent chat')
    log(
      'error',
      action,
      `Hand-off of ${itemId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
