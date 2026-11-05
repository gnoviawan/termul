import type { GithubItemDetail } from '@shared/types/github.types'
import { itemReference, itemSummaryData } from './item-context'
import type { HandoffPrompt } from './untrusted'

/**
 * CAP-5 Start: the editable card an issue seeds into a new worktree chat. The
 * user sends it; nothing here is dispatched on its own.
 */
export function startIssuePrompt(detail: GithubItemDetail): HandoffPrompt {
  const ref = itemReference(detail.repo, detail.item.number)
  return {
    instructions: [
      `Work on GitHub issue ${ref} in this worktree.`,
      'Read the issue below, find the cause in the code, make the change, and add or update tests.',
      'Do not close the issue or post to GitHub.'
    ].join('\n'),
    data: `Issue ${ref}\n${itemSummaryData(detail)}`
  }
}
