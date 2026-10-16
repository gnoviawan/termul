import type { GitCommit } from '@shared/types/ipc.types'

/** True when a lower-case query matches the commit's subject, author, hash
 * (short or full) or a ref decoration. One matcher for both shells. */
export function matchesCommitQuery(commit: GitCommit, q: string): boolean {
  return (
    commit.subject.toLowerCase().includes(q) ||
    commit.author.toLowerCase().includes(q) ||
    commit.shortHash.toLowerCase().includes(q) ||
    commit.hash.toLowerCase().includes(q) ||
    commit.refs.some((r) => r.toLowerCase().includes(q))
  )
}
