import type { GitFileStatus } from '@shared/types/ipc.types'
import { Check, FileCode, FileQuestion, Minus, Pencil, Plus, RotateCcw } from 'lucide-react'

/** Human-readable labels for each git file status, shared across git surfaces. */
export const GIT_STATUS_LABELS: Record<GitFileStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  staged: 'Staged'
}

/** Status badge icon + label, shared by GitPanel and ChatChangedFilesPanel. */
export function GitStatusBadge({ status }: { status: GitFileStatus }) {
  const label = GIT_STATUS_LABELS[status]
  let icon: React.ReactNode
  switch (status) {
    case 'added':
      icon = <Plus className="text-green-500" size={14} aria-hidden />
      break
    case 'modified':
      icon = <Pencil className="text-amber-500" size={14} aria-hidden />
      break
    case 'deleted':
      icon = <Minus className="text-red-500" size={14} aria-hidden />
      break
    case 'renamed':
      icon = <RotateCcw className="text-blue-500" size={14} aria-hidden />
      break
    case 'untracked':
      icon = <FileQuestion className="text-orange-500" size={14} aria-hidden />
      break
    case 'staged':
      icon = <Check className="text-primary" size={14} aria-hidden />
      break
    default:
      icon = <FileCode size={14} aria-hidden />
  }

  return (
    <div
      role="img"
      className="flex h-5 w-5 shrink-0 items-center justify-center"
      title={label}
      aria-label={label}
    >
      {icon}
    </div>
  )
}
