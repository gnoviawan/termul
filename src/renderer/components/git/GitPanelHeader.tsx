import type React from 'react'
import { BranchSection } from '@/components/git/BranchSection'
import { ChangesFilter } from '@/components/git/rows'
import { Archive } from '@/components/icons'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cn } from '@/lib/utils'

interface GitPanelHeaderProps {
  /** `column` is the desktop look inside the shell Changes panel: the branch
      row, then the `belowBranch` slot (the commit box), then the filter field. */
  variant: 'desktop' | 'mobile' | 'column'
  branches: string[]
  currentBranch: string | null | undefined
  /** Commits ahead of upstream; shown next to the branch when > 0. */
  ahead?: number
  hasUncommittedChanges: boolean
  isGenerating: boolean
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  onCreateBranch: () => void
  onSwitchBranch: (name: string) => void
  onOpenStash: () => void
  /** `column` only: rendered between the branch row and the filter field. */
  belowBranch?: React.ReactNode
}

/**
 * Story 10: the mobile web shell (≤767px) grows the controls to the touch
 * floor. Mobile `pr-14` reserves the sheet close target so it does not overlap
 * the Stash changes button at the right edge of the branch row.
 */
const HEADER_CHROME = {
  desktop: { row: 'h-10 pl-2 pr-1.5', stashButton: 'size-7', stashIcon: 14 },
  column: { row: 'h-10 pl-2 pr-1.5', stashButton: 'size-7', stashIcon: 14 },
  mobile: { row: 'min-h-14 pl-1 pr-14', stashButton: 'size-11', stashIcon: 16 }
} as const

/** Branch picker + ahead count + Stash button + "Filter changes" field. */
export function GitPanelHeader({
  variant,
  branches,
  currentBranch,
  ahead = 0,
  hasUncommittedChanges,
  isGenerating,
  searchQuery,
  onSearchQueryChange,
  onCreateBranch,
  onSwitchBranch,
  onOpenStash,
  belowBranch
}: GitPanelHeaderProps) {
  const admitted = useServerAdmitsRemoteWrites()
  const chrome = HEADER_CHROME[variant]
  const isMobile = variant === 'mobile'

  return (
    <>
      <div className={cn('flex shrink-0 items-center gap-1', chrome.row)}>
        {/* BranchSection's trigger carries its own px-2, so pl-2 here puts
            the branch icon on the 16px panel inset. */}
        <BranchSection
          variant={isMobile ? 'mobile' : undefined}
          branches={branches}
          currentBranch={currentBranch}
          onCreateBranch={onCreateBranch}
          onSwitchBranch={onSwitchBranch}
        />
        {ahead > 0 && (
          <span
            className="shrink-0 text-2xs tabular-nums text-muted-foreground"
            title={`${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream`}
          >
            ↑{ahead}
          </span>
        )}
        <WriteGate gated={!admitted} className="ml-auto shrink-0">
          <button
            type="button"
            className={cn(
              QUIET_ICON_BUTTON_CLASS,
              'flex shrink-0 disabled:cursor-not-allowed disabled:opacity-40',
              admitted && 'ml-auto',
              chrome.stashButton
            )}
            title="Stash changes"
            aria-label="Stash changes"
            onClick={onOpenStash}
            disabled={!hasUncommittedChanges || isGenerating || !admitted}
          >
            <Archive size={chrome.stashIcon} />
          </button>
        </WriteGate>
      </div>

      {variant === 'column' && belowBranch}

      <div
        className={cn(
          'shrink-0 px-2 pb-2',
          variant === 'column' && belowBranch && 'border-t border-border pt-2'
        )}
      >
        <ChangesFilter
          value={searchQuery}
          onChange={onSearchQueryChange}
          variant={isMobile ? 'mobile' : undefined}
        />
      </div>
    </>
  )
}
