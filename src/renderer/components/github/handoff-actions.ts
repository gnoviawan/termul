import type { GithubChecksResult, GithubItemDetail } from '@shared/types/github.types'
import { failedChecks } from '@/lib/github-handoff/fix-ci'
import type { GithubHandoffAction } from '@/stores/github-chat-links-store'

export const FORK_PUSH_BLOCKED_REASON =
  "This fork PR doesn't allow maintainer edits, so an agent can't push to it."

export interface HandoffActionState {
  action: GithubHandoffAction
  label: string
  /** Needs the server to admit writes (it makes a worktree). */
  writes: boolean
  /** Why the action is off, shown next to the bar; null when it can run. */
  blockedReason: string | null
}

/**
 * The hand-off actions an item offers right now. Issues: Start and Ask. PRs:
 * Review and Ask, plus Fix CI when a check failed and Resolve comments when a
 * review thread is unresolved (open PRs only). A fork PR that refuses
 * maintainer edits blocks the two actions that push.
 */
export function handoffActions(
  detail: GithubItemDetail,
  checks: GithubChecksResult | null,
  canUseWorktree: boolean
): HandoffActionState[] {
  const noWorktree = canUseWorktree ? null : 'This project is not a git repository.'
  const { pr, item } = detail
  if (!pr) {
    return [
      { action: 'start', label: 'Start', writes: true, blockedReason: noWorktree },
      { action: 'ask', label: 'Ask', writes: false, blockedReason: null }
    ]
  }
  const actions: HandoffActionState[] = [
    { action: 'review', label: 'Review', writes: false, blockedReason: null },
    { action: 'ask', label: 'Ask', writes: false, blockedReason: null }
  ]
  if (item.state !== 'open' && item.state !== 'draft') return actions
  const pushBlocked =
    pr.isCrossRepository && !pr.maintainerCanModify ? FORK_PUSH_BLOCKED_REASON : noWorktree
  if (checks && failedChecks(checks).length > 0) {
    actions.push({ action: 'fix_ci', label: 'Fix CI', writes: true, blockedReason: pushBlocked })
  }
  if (pr.reviewThreads.some((thread) => !thread.isResolved)) {
    actions.push({
      action: 'resolve_comments',
      label: 'Resolve comments',
      writes: true,
      blockedReason: pushBlocked
    })
  }
  return actions
}
