import type {
  GithubCheck,
  GithubCheckLog,
  GithubCheckoutPrResult,
  GithubChecksResult,
  GithubItemDetail
} from '@shared/types/github.types'
import { itemReference } from './item-context'
import type { HandoffPrompt } from './untrusted'

/** Most failed Actions jobs whose log tails go into one Fix CI prompt. */
export const FIX_CI_MAX_LOGS = 5

export function failedChecks(checks: GithubChecksResult): GithubCheck[] {
  return checks.checks.filter((check) => check.status === 'failure')
}

/** The failed checks whose Actions job log Fix CI fetches, at most {@link FIX_CI_MAX_LOGS}. */
export function checksToFetchLogs(checks: GithubChecksResult): GithubCheck[] {
  return failedChecks(checks)
    .filter((check) => check.jobId !== null)
    .slice(0, FIX_CI_MAX_LOGS)
}

export interface FixCiInput {
  detail: GithubItemDetail
  checks: GithubChecksResult
  /** Log tails by job id; a missing entry means the log could not be read. */
  logs: ReadonlyMap<number, GithubCheckLog>
  checkout: GithubCheckoutPrResult
}

function checkLine(check: GithubCheck): string {
  const workflow = check.workflow ? ` (workflow: ${check.workflow})` : ''
  const details = check.detailsUrl ? ` ${check.detailsUrl}` : ''
  return `- ${check.name}${workflow}${details}`
}

/**
 * CAP-7 Fix CI. The evidence (failed check names, workflows, and the log tails
 * of up to five failed jobs) is pinned to the head SHA it was captured at;
 * the check list comes first so the budget cuts log text before it.
 */
export function fixCiPrompt({ detail, checks, logs, checkout }: FixCiInput): HandoffPrompt {
  const ref = itemReference(detail.repo, detail.item.number)
  const failed = failedChecks(checks)
  const instructions = [
    `Fix the failing CI checks on pull request ${ref}.`,
    `This worktree is checked out at the PR head branch ${checkout.headRefName}, commit ${checkout.headSha}.`,
    `The check evidence below was captured at commit ${checks.headSha}.`,
    'Find the cause of each failure, fix it, and run the relevant tests locally where you can.',
    `Commit the fix and push it with: ${checkout.pushCommand}`,
    'Do not merge, close, or comment on the pull request.'
  ]
  if (checks.headSha !== checkout.headSha) {
    instructions.splice(
      3,
      0,
      'The PR head moved after the checks ran, so some failures may already be fixed or changed.'
    )
  }
  const sections = [`Failed checks on ${ref} at ${checks.headSha}:`, ...failed.map(checkLine)]
  for (const check of checksToFetchLogs(checks)) {
    const log = check.jobId === null ? undefined : logs.get(check.jobId)
    sections.push(
      '',
      `Log tail of "${check.name}" (job ${check.jobId})${log?.truncated ? ', last lines only' : ''}:`,
      log ? log.tail : '(log unavailable)'
    )
  }
  return { instructions: instructions.join('\n'), data: sections.join('\n') }
}
