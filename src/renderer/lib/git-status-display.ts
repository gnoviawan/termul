import type { GitFileStatus } from '@shared/types/ipc.types'

/**
 * Display vocabulary for a changed file, shared by the Git panel rows and the
 * file explorer. `staged` is not a file state of its own: show it as the
 * change it stages.
 */
export type GitDisplayStatus = Exclude<GitFileStatus, 'staged'>

export const GIT_STATUS_LETTER: Record<GitDisplayStatus, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R'
}

export const GIT_STATUS_LABEL: Record<GitDisplayStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  untracked: 'Untracked',
  deleted: 'Deleted',
  renamed: 'Renamed'
}

/** Name tint per status. The letter uses the same tint. */
export const GIT_STATUS_TEXT_CLASS: Record<GitDisplayStatus, string> = {
  modified: 'text-diff-modified',
  renamed: 'text-diff-modified',
  added: 'text-diff-added',
  untracked: 'text-diff-added',
  deleted: 'text-destructive'
}
