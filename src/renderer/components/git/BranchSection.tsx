import { Check, ChevronDown, GitBranch, Plus } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface BranchSectionProps {
  /** Story 10: `mobile` grows the trigger to the 44px touch floor. */
  variant?: 'mobile'
  branches: string[]
  /** Current branch name (`commitContext?.branch`); null shows "Detached HEAD". */
  currentBranch: string | null | undefined
  /** Opens the create-branch dialog. */
  onCreateBranch: () => void
  onSwitchBranch: (name: string) => void
}

export function BranchSection({
  variant,
  branches,
  currentBranch,
  onCreateBranch,
  onSwitchBranch
}: BranchSectionProps) {
  const isMobile = variant === 'mobile'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={isMobile ? 'touch' : 'sm'}
          className={cn(
            'px-2 font-medium text-xs flex items-center gap-1.5 max-w-[190px] truncate hover:bg-secondary',
            isMobile ? 'min-h-11' : 'h-8'
          )}
        >
          <GitBranch size={isMobile ? 14 : 13} className="text-muted-foreground shrink-0" />
          <span className="truncate">{currentBranch ?? 'Detached HEAD'}</span>
          <ChevronDown size={12} className="text-muted-foreground opacity-50 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 max-h-[300px] overflow-y-auto z-50">
        <DropdownMenuItem
          onClick={onCreateBranch}
          className="flex items-center gap-2 text-xs cursor-pointer"
        >
          <Plus size={12} />
          Create new branch...
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {branches.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No branches found</div>
        ) : (
          branches.map((b) => (
            <DropdownMenuItem
              key={b}
              onClick={() => onSwitchBranch(b)}
              className={cn(
                'flex items-center justify-between text-xs cursor-pointer',
                b === currentBranch && 'bg-accent font-semibold'
              )}
            >
              <span className="truncate">{b}</span>
              {b === currentBranch && <Check size={12} className="text-primary" />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "Create New Branch" dialog. Rendered at the panel root (not inside the
 * branch dropdown) so it stays mounted across the mobile file-list/diff-view
 * swap.
 */
export function CreateBranchDialog({
  open,
  onOpenChange,
  branchName,
  onBranchNameChange,
  isMutating,
  isGenerating,
  onCreate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  branchName: string
  onBranchNameChange: (value: string) => void
  isMutating: boolean
  isGenerating: boolean
  onCreate: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Branch</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2 text-xs">
          <div className="space-y-1">
            <label className="text-muted-foreground">Branch name</label>
            <input
              type="text"
              className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 focus:ring-1 focus:ring-primary outline-none text-xs"
              placeholder="e.g. feature/new-login"
              value={branchName}
              onChange={(e) => onBranchNameChange(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onCreate}
            disabled={!branchName.trim() || isMutating || isGenerating}
          >
            Create &amp; Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Uncommitted Changes" branch-switch confirmation: carry changes over to the
 * target branch, or auto-stash → switch → pop. Rendered at the panel root so
 * it stays mounted across the mobile file-list/diff-view swap.
 */
export function BranchSwitchDialog({
  open,
  onOpenChange,
  pendingBranchName,
  isMutating,
  isGenerating,
  onExecute
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingBranchName: string
  isMutating: boolean
  isGenerating: boolean
  onExecute: (strategy: 'bring' | 'stash') => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Uncommitted Changes</DialogTitle>
        </DialogHeader>
        <div className="py-2 text-xs text-muted-foreground space-y-2">
          <p>
            You have uncommitted changes on your current branch. How would you like to handle them
            before switching to <strong>{pendingBranchName}</strong>?
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li>
              <strong>Bring Changes:</strong> Keep your changes and carry them over to the new
              branch.
            </li>
            <li>
              <strong>Stash &amp; Switch:</strong> Stash your changes on this branch, switch, and
              try to re-apply them on the new branch.
            </li>
          </ul>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onExecute('bring')}
            disabled={isMutating || isGenerating}
          >
            Bring Changes
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => onExecute('stash')}
            disabled={isMutating || isGenerating}
          >
            Stash &amp; Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
