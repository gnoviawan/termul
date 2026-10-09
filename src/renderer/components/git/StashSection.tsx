import type { GitStashInfo } from '@shared/types/ipc.types'
import { SectionHeader } from '@/components/git/rows'
import { ArchiveRestore, ClipboardPaste, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface StashSectionProps {
  /** Story 10 (QA F4/F7): `mobile` renders always-visible `touch` buttons
      (44px floor via hit-slop); desktop keeps hover-gated icon buttons. */
  variant?: 'mobile'
  stashes: GitStashInfo[]
  isMutating: boolean
  isGenerating: boolean
  onApply: (index: number) => void
  onPop: (index: number) => void
  onDrop: (index: number) => void
}

export function StashSection({
  variant,
  stashes,
  isMutating,
  isGenerating,
  onApply,
  onPop,
  onDrop
}: StashSectionProps) {
  if (stashes.length === 0) {
    return null
  }
  const isMobile = variant === 'mobile'
  return (
    <div className="space-y-1 pt-2 border-t border-border/30 w-full min-w-0">
      <SectionHeader label="Stashes" count={stashes.length} selectionCount={0} />
      <div className="space-y-0.5 w-full min-w-0">
        {stashes.map((s) =>
          isMobile ? (
            <div
              key={s.index}
              className="flex w-full min-w-0 items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-foreground cursor-default transition-all"
            >
              <div className="flex flex-col min-w-0 flex-1">
                <span className="font-semibold text-muted-foreground text-xs">{`stash@{${s.index}}`}</span>
                <span
                  className="truncate text-muted-foreground text-xs leading-tight"
                  title={s.message}
                >
                  {s.message || 'No message'}
                </span>
              </div>
              {/* Story 10 (QA F4/F7): hover-only stash actions are
                  invisible and untappable on touch — the mobile
                  block renders always-visible `touch` buttons
                  (44px floor via hit-slop). Drop is destructive. */}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  className="w-11 text-muted-foreground"
                  aria-label="Apply stash (keeps stash entry)"
                  title="Apply stash (keeps stash entry)"
                  disabled={isMutating || isGenerating}
                  onClick={() => onApply(s.index)}
                >
                  <ClipboardPaste size={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  className="w-11 text-muted-foreground"
                  aria-label="Pop stash (applies and drops)"
                  title="Pop stash (applies and drops)"
                  disabled={isMutating || isGenerating}
                  onClick={() => onPop(s.index)}
                >
                  <ArchiveRestore size={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  className="w-11 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Drop stash"
                  title="Drop stash"
                  disabled={isMutating || isGenerating}
                  onClick={() => onDrop(s.index)}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>
          ) : (
            <div
              key={s.index}
              className="group flex w-full min-w-0 items-center justify-between px-2 py-1.5 rounded hover:bg-secondary/40 text-xs text-foreground cursor-default transition-all"
            >
              <div className="flex flex-col min-w-0 flex-1 pr-1.5">
                <span className="font-semibold text-muted-foreground text-3xs">{`stash@{${s.index}}`}</span>
                <span
                  className="truncate text-muted-foreground text-2xs leading-tight"
                  title={s.message}
                >
                  {s.message || 'No message'}
                </span>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  type="button"
                  title="Apply stash (keeps stash entry)"
                  onClick={() => onApply(s.index)}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <ClipboardPaste size={11} />
                </button>
                <button
                  type="button"
                  title="Pop stash (applies and drops)"
                  onClick={() => onPop(s.index)}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <ArchiveRestore size={11} />
                </button>
                <button
                  type="button"
                  title="Drop stash"
                  onClick={() => onDrop(s.index)}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

/**
 * "Stash Changes" dialog. Rendered at the panel root (not inside the stash
 * list) so it stays mounted across the mobile file-list/diff-view swap and is
 * reachable even when no stash exists yet.
 */
export function StashDialog({
  open,
  onOpenChange,
  message,
  onMessageChange,
  includeUntracked,
  onIncludeUntrackedChange,
  isMutating,
  isGenerating,
  onSave
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  message: string
  onMessageChange: (value: string) => void
  includeUntracked: boolean
  onIncludeUntrackedChange: (checked: boolean) => void
  isMutating: boolean
  isGenerating: boolean
  onSave: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Stash Changes</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2 text-xs">
          <div className="space-y-1">
            <label className="text-muted-foreground">Message (optional)</label>
            <input
              type="text"
              className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 focus:ring-1 focus:ring-primary outline-none text-xs pointer-coarse:text-base"
              placeholder="WIP on current branch..."
              value={message}
              onChange={(e) => onMessageChange(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none text-2xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={includeUntracked}
              onChange={(e) => onIncludeUntrackedChange(e.target.checked)}
            />
            Include untracked files
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onSave}
            disabled={isMutating || isGenerating}
          >
            Stash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
