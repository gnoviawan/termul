import { BranchSection } from '@/components/git/BranchSection'
import { Archive, Search } from '@/components/icons'
import { Button } from '@/components/ui/button'

interface GitPanelHeaderProps {
  variant: 'desktop' | 'mobile'
  branches: string[]
  currentBranch: string | null | undefined
  hasUncommittedChanges: boolean
  isGenerating: boolean
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  onCreateBranch: () => void
  onSwitchBranch: (name: string) => void
  onOpenStash: () => void
}

/** Branch picker + Stash button + "Filter changes..." input. */
export function GitPanelHeader({
  variant,
  branches,
  currentBranch,
  hasUncommittedChanges,
  isGenerating,
  searchQuery,
  onSearchQueryChange,
  onCreateBranch,
  onSwitchBranch,
  onOpenStash
}: GitPanelHeaderProps) {
  if (variant === 'mobile') {
    return (
      // pr-14 reserves the sheet close target so it does not overlap the
      // Stash changes button at the right edge of the first row.
      <div className="p-2 pr-14 border-b border-border flex flex-col gap-2 bg-muted/20">
        <div className="flex items-center justify-between">
          <BranchSection
            variant="mobile"
            branches={branches}
            currentBranch={currentBranch}
            onCreateBranch={onCreateBranch}
            onSwitchBranch={onSwitchBranch}
          />

          <Button
            variant="ghost"
            size="touch"
            className="w-11 text-muted-foreground hover:text-foreground hover:bg-secondary"
            title="Stash changes"
            onClick={onOpenStash}
            disabled={!hasUncommittedChanges || isGenerating}
          >
            <Archive size={16} />
          </Button>
        </div>

        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={14}
          />
          <input
            type="text"
            placeholder="Filter changes..."
            className="w-full bg-secondary/50 border-none rounded-md py-2.5 pl-8 pr-3 text-xs pointer-coarse:text-base focus:ring-1 focus:ring-primary outline-none"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="p-3 border-b border-border flex flex-col gap-2 bg-muted/20">
      <div className="flex items-center justify-between">
        <BranchSection
          branches={branches}
          currentBranch={currentBranch}
          onCreateBranch={onCreateBranch}
          onSwitchBranch={onSwitchBranch}
        />

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary"
          title="Stash changes"
          onClick={onOpenStash}
          disabled={!hasUncommittedChanges || isGenerating}
        >
          <Archive size={14} />
        </Button>
      </div>

      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          size={14}
        />
        <input
          type="text"
          placeholder="Filter changes..."
          className="w-full bg-secondary/50 border-none rounded-md py-1.5 pl-8 pr-3 text-xs pointer-coarse:text-base focus:ring-1 focus:ring-primary outline-none"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
        />
      </div>
    </div>
  )
}
