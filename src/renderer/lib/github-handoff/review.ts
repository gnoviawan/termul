import type { GithubItemDetail, GithubPullDetail } from '@shared/types/github.types'
import { ghRepoArg, itemReference, itemSummaryData } from './item-context'
import type { HandoffPrompt } from './untrusted'

/** Review: a read-only chat's first turn. The agent reads the PR with `gh` and reports; it never posts. */
export function reviewPrPrompt(detail: GithubItemDetail, pr: GithubPullDetail): HandoffPrompt {
  const { number } = detail.item
  const repoArg = ghRepoArg(detail.repo)
  return {
    instructions: [
      `Review pull request ${itemReference(detail.repo, number)}.`,
      `Read it with \`gh pr view ${number} --repo ${repoArg} --comments\`, \`gh pr diff ${number} --repo ${repoArg}\` and \`gh pr checks ${number} --repo ${repoArg}\`.`,
      'Report correctness bugs, risky changes and missing tests, most severe first, each with its file and line.',
      'Do not post the review or any comment to GitHub, and do not change files.'
    ].join('\n'),
    data: [
      `Pull request ${itemReference(detail.repo, number)}`,
      `Head: ${pr.headRefName} (${pr.headSha})`,
      `Base: ${pr.baseRefName}`,
      itemSummaryData(detail)
    ].join('\n')
  }
}
