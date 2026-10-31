import type {
  GithubCheckoutPrResult,
  GithubItemDetail,
  GithubReviewThread
} from '@shared/types/github.types'
import { commentData, itemReference } from './item-context'
import { fitUntrustedRecords, type HandoffPrompt } from './untrusted'

export interface ResolveCommentsInput {
  detail: GithubItemDetail
  /** Only the threads the user selected; unselected threads never reach the prompt. */
  threads: GithubReviewThread[]
  checkout: GithubCheckoutPrResult
}

function threadData(thread: GithubReviewThread, index: number): string {
  const location = thread.line === null ? thread.path : `${thread.path}:${thread.line}`
  const lines = [`Thread ${index + 1}: ${location}${thread.isOutdated ? ' (outdated)' : ''}`]
  const url = thread.comments[0]?.url
  if (url) lines.push(`URL: ${url}`)
  for (const comment of thread.comments) lines.push(commentData(comment))
  return lines.join('\n')
}

/**
 * CAP-8 Resolve comments. Termul never resolves a thread: the agent changes
 * code and pushes, and the user resolves threads on GitHub.
 */
export function resolveCommentsPrompt({
  detail,
  threads,
  checkout
}: ResolveCommentsInput): HandoffPrompt {
  const ref = itemReference(detail.repo, detail.item.number)
  return {
    instructions: [
      `Address ${threads.length === 1 ? 'one review thread' : `${threads.length} review threads`} on pull request ${ref}.`,
      `This worktree is checked out at the PR head branch ${checkout.headRefName}, commit ${checkout.headSha}.`,
      'For each thread, make the change the reviewer asks for, or explain why it should not be made.',
      'An outdated thread refers to code that has changed since; check whether it still applies.',
      `Commit the changes and push them with: ${checkout.pushCommand}`,
      'Do not resolve threads, reply to them, or post anything to GitHub.'
    ].join('\n'),
    data: fitUntrustedRecords(`Review threads on ${ref}:`, threads.map(threadData))
  }
}
