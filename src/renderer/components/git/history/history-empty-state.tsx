import type React from 'react'
import { History } from '@/components/icons'

/** Shown when a working copy has no commits to list: a failed read (not a Git
 * folder) or an empty repository. Shared by the desktop and phone histories. */
export function HistoryEmptyState({ error }: { error: string | null }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground/50">
        <History size={24} />
      </div>
      <h3 className="mb-1 text-sm font-medium text-foreground">No commit history</h3>
      <p className="max-w-[260px] text-xs">
        {error
          ? 'This folder may not be a Git repository, or git is unavailable.'
          : 'There are no commits to show yet. Make your first commit to see it here.'}
      </p>
    </div>
  )
}
