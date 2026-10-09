import type { GitStashInfo } from '@shared/types/ipc.types'
import { RowAction, SectionHeader } from '@/components/git/rows'
import { ArchiveRestore, ClipboardPaste, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

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

/** Desktop rows are dense with hover-gated actions; mobile lifts text to 12px. */
const STASH_ROW_CHROME = {
  desktop: {
    row: 'group gap-2 py-1 pl-2 pr-1 transition-colors duration-150 ease-out hover:bg-foreground/[0.03]',
    text: 'pr-1.5',
    ref: 'text-3xs',
    message: 'text-2xs'
  },
  mobile: {
    row: 'gap-2 px-2 py-1.5',
    text: '',
    ref: 'text-xs',
    message: 'text-xs'
  }
} as const

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
  const chrome = STASH_ROW_CHROME[variant ?? 'desktop']
  return (
    <div className="w-full min-w-0 border-t border-border pt-2">
      <SectionHeader label="Stashes" count={stashes.length} selectionCount={0} />
      <div className="space-y-0.5 w-full min-w-0">
        {stashes.map((s) => {
          const actions = [
            {
              label: 'Apply stash (keeps stash entry)',
              Icon: ClipboardPaste,
              onClick: () => onApply(s.index)
            },
            {
              label: 'Pop stash (applies and drops)',
              Icon: ArchiveRestore,
              onClick: () => onPop(s.index)
            },
            {
              label: 'Drop stash',
              Icon: Trash2,
              onClick: () => onDrop(s.index),
              variant: 'danger' as const
            }
          ]
          return (
            <div
              key={s.index}
              className={cn(
                'flex w-full min-w-0 items-center justify-between rounded-md text-xs text-foreground cursor-default',
                chrome.row
              )}
            >
              <div className={cn('flex flex-col min-w-0 flex-1', chrome.text)}>
                <span
                  className={cn('font-semibold text-muted-foreground', chrome.ref)}
                >{`stash@{${s.index}}`}</span>
                <span
                  className={cn('truncate text-muted-foreground leading-tight', chrome.message)}
                  title={s.message}
                >
                  {s.message || 'No message'}
                </span>
              </div>
              {isMobile ? (
                // Story 10 (QA F4/F7): hover-only stash actions are invisible
                // and untappable on touch — mobile renders always-visible
                // `touch` buttons (44px floor). Drop is destructive.
                <div className="flex shrink-0 items-center gap-1">
                  {actions.map(({ label, Icon, onClick, variant: tone }) => (
                    <Button
                      key={label}
                      type="button"
                      variant="ghost"
                      size="touch"
                      className={cn(
                        'w-11 text-muted-foreground',
                        tone === 'danger' && 'hover:bg-destructive/10 hover:text-destructive'
                      )}
                      aria-label={label}
                      title={label}
                      disabled={isMutating || isGenerating}
                      onClick={onClick}
                    >
                      <Icon size={16} />
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150 ease-out shrink-0">
                  {actions.map(({ label, Icon, onClick, variant: tone }) => (
                    <RowAction
                      key={label}
                      icon={<Icon size={13} />}
                      label={label}
                      variant={tone}
                      disabled={isMutating || isGenerating}
                      onClick={onClick}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
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
              className={cn(PANEL_FIELD_CLASS, 'w-full rounded-md px-3 py-1.5')}
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
