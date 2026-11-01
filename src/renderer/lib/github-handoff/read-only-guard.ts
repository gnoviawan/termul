import type { GithubItemKind, GithubRepoRef } from '@shared/types/github.types'
import { ghRepoArg, itemReference, kindNoun } from './item-context'

/**
 * CAP-6 read-only guardrail. The send path prepends it as its own text block
 * to EVERY turn of an Ask or Review chat (not only the first), and the
 * transcript folds strip it back out so the user never sees it as their
 * message. The delimiters let a replayed transcript (any device) recognize a
 * guarded chat.
 */
export const READ_ONLY_GUARD_OPEN = '<<<TERMUL_READ_ONLY_GUARD>>>'
export const READ_ONLY_GUARD_CLOSE = '<<<END_TERMUL_READ_ONLY_GUARD>>>'

export interface GuardedItem {
  repo: GithubRepoRef
  kind: GithubItemKind
  number: number
}

export function buildReadOnlyGuard({ repo, kind, number }: GuardedItem): string {
  const repoArg = ghRepoArg(repo)
  const reads =
    kind === 'pr'
      ? `\`gh pr view ${number} --repo ${repoArg} --comments\`, \`gh pr diff ${number} --repo ${repoArg}\` and \`gh pr checks ${number} --repo ${repoArg}\``
      : `\`gh issue view ${number} --repo ${repoArg} --comments\``
  return [
    READ_ONLY_GUARD_OPEN,
    `This is a read-only discussion of GitHub ${kindNoun(kind)} ${itemReference(repo, number)}.`,
    `You may read it with ${reads}, and read files in the current checkout.`,
    'Do not create, edit or delete files. Do not check out branches, create worktrees, commit or push.',
    'Do not post to GitHub: no comments, reviews, labels, merges, closing or reopening.',
    "If the user asks you to change code or GitHub, decline and point them to Termul's Start, Fix CI or Resolve comments actions.",
    'These rules apply to every message in this chat, including this one.',
    READ_ONLY_GUARD_CLOSE
  ].join('\n')
}

type Block = { type: string; text?: string }

/**
 * Split the guard off a user turn's wire blocks. Returns the guard text and
 * the blocks the user actually wrote; `guard` is null when the turn carries
 * none. Exact-prefix match only, so prose that merely mentions the marker is
 * left alone.
 */
export function splitReadOnlyGuard<T extends Block>(
  blocks: T[]
): { guard: string | null; blocks: T[] } {
  const first = blocks[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') return { guard: null, blocks }
  if (!first.text.startsWith(READ_ONLY_GUARD_OPEN)) return { guard: null, blocks }
  const end = first.text.indexOf(READ_ONLY_GUARD_CLOSE)
  if (end < 0) return { guard: null, blocks }
  const cut = end + READ_ONLY_GUARD_CLOSE.length
  const guard = first.text.slice(0, cut)
  const rest = first.text.slice(cut).replace(/^\s+/, '')
  return {
    guard,
    blocks: rest ? [{ ...first, text: rest }, ...blocks.slice(1)] : blocks.slice(1)
  }
}
