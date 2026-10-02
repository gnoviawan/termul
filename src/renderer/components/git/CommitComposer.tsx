import type { GitCommitContext } from '@shared/types/ipc.types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ArrowUp, GitCommit, MoreHorizontal, Sparkles } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface CommitComposerProps {
  /** Story 10: `mobile` de-stacks the footer — inline Generate sparkle, larger
      touch targets, Push/Publish in an overflow menu when no upstream exists. */
  variant?: 'mobile'
  summary: string
  onSummaryChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  amend: boolean
  onToggleAmend: () => void
  isCommitting: boolean
  isGenerating: boolean
  isPushing: boolean
  commitContext: GitCommitContext | null
  stagedCount: number
  hasUsableAgent: boolean
  canGenerate: boolean
  canCommit: boolean
  onGenerateMessage: () => void
  onCommit: () => void
  onPush: () => void
}

export function CommitComposer({
  variant,
  summary,
  onSummaryChange,
  description,
  onDescriptionChange,
  amend,
  onToggleAmend,
  isCommitting,
  isGenerating,
  isPushing,
  commitContext,
  stagedCount,
  hasUsableAgent,
  canGenerate,
  canCommit,
  onGenerateMessage,
  onCommit,
  onPush
}: CommitComposerProps) {
  const onBranch = !!commitContext?.branch
  const ahead = commitContext?.ahead ?? 0
  const behind = commitContext?.behind ?? 0
  // Once an upstream exists, there is nothing to push when we are not ahead.
  // Before an upstream exists, publishing is always meaningful.
  const hasSomethingToPush = !commitContext?.hasUpstream || ahead > 0
  const canPush = onBranch && hasSomethingToPush && !isPushing && !isCommitting && !isGenerating
  const pushLabel = !commitContext?.hasUpstream
    ? 'Publish branch'
    : ahead > 0
      ? `Push ${ahead}`
      : 'Up to date'

  if (variant === 'mobile') {
    return (
      // Story 10 / QA F9: mobile de-stacks the four equal-weight buttons — the
      // summary row carries an inline Generate sparkle, Amend is a de-weighted
      // checkbox, Commit is the only primary, and Push/Publish moves into an
      // overflow menu until an upstream exists (reachable either way).
      <div className="border-t border-border p-2 space-y-2 bg-background/60">
        <div className="relative">
          <input
            type="text"
            aria-label="Commit summary"
            placeholder={amend ? 'Update commit message' : 'Summary (required)'}
            className="w-full bg-secondary/50 border-none rounded-md py-2.5 pl-3 pr-12 text-xs focus:ring-1 focus:ring-primary outline-none"
            value={summary}
            onChange={(e) => onSummaryChange(e.target.value)}
            disabled={isCommitting || isGenerating}
          />
          {/* Generate message lives inline in the summary field (QA F9):
              a sparkle that fills the message, not a stacked button. */}
          <button
            type="button"
            aria-label="Generate commit message"
            title={
              stagedCount === 0
                ? 'Stage files to generate a commit message'
                : !hasUsableAgent
                  ? 'Configure and select an ACP agent'
                  : 'Generate a commit message from staged changes'
            }
            onClick={() => void onGenerateMessage()}
            disabled={!canGenerate}
            className={cn(
              'absolute right-1.5 top-1/2 -translate-y-1/2 flex size-8 items-center justify-center rounded-md',
              // 32px visual + hit-slop after:-inset-1.5 → ~48×48 tap.
              "relative after:absolute after:-inset-1.5 after:content-['']",
              'text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed',
              isGenerating && 'animate-pulse text-primary'
            )}
          >
            <Sparkles size={15} />
          </button>
        </div>
        <textarea
          aria-label="Commit description"
          placeholder="Description (optional)"
          rows={3}
          className="w-full resize-none bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          disabled={isCommitting || isGenerating}
        />
        <label
          className={cn(
            'flex items-center gap-2 text-xs select-none',
            commitContext?.hasHead
              ? 'text-muted-foreground cursor-pointer'
              : 'text-muted-foreground/75 cursor-not-allowed'
          )}
          title={
            commitContext?.hasHead
              ? 'Amend the last commit instead of creating a new one'
              : 'No commit to amend yet'
          }
        >
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={amend}
            onChange={onToggleAmend}
            disabled={!commitContext?.hasHead || isCommitting || isGenerating}
          />
          Amend last commit
        </label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="touch"
            className="h-11 flex-1 text-xs gap-2"
            onClick={onCommit}
            disabled={!canCommit}
            title={
              amend
                ? 'Amend the last commit'
                : stagedCount === 0
                  ? 'Stage files to commit'
                  : 'Commit staged changes'
            }
          >
            <GitCommit size={14} />
            {isCommitting
              ? 'Committing...'
              : amend
                ? 'Amend commit'
                : commitContext?.branch
                  ? `Commit to ${commitContext.branch}`
                  : 'Commit'}
          </Button>
          {commitContext?.hasUpstream ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="h-11 shrink-0 px-3 text-xs gap-2"
              onClick={onPush}
              disabled={!canPush}
              title={
                !onBranch
                  ? 'Not on a branch (detached HEAD)'
                  : ahead > 0
                    ? 'Push commits to the remote'
                    : 'Nothing to push — up to date with the remote'
              }
            >
              <ArrowUp size={14} className={cn(isPushing && 'animate-pulse')} />
              {isPushing ? 'Pushing...' : pushLabel}
              {behind > 0 && <span className="text-xs tabular-nums text-warning">↓{behind}</span>}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="h-11 shrink-0 px-3"
                  aria-label="More actions"
                  title="Publish branch and more actions"
                >
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 z-50">
                <DropdownMenuItem
                  disabled={!canPush}
                  onSelect={() => {
                    if (!isPushing) void onPush()
                  }}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <ArrowUp size={14} />
                  {isPushing ? 'Pushing...' : pushLabel}
                  {behind > 0 && (
                    <span className="ml-auto text-xs tabular-nums text-warning">↓{behind}</span>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    )
  }

  return (
    // Commit footer (GitHub Desktop style)
    <div className="border-t border-border p-3 space-y-2 bg-background/60">
      <input
        type="text"
        aria-label="Commit summary"
        placeholder={amend ? 'Update commit message' : 'Summary (required)'}
        className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
        value={summary}
        onChange={(e) => onSummaryChange(e.target.value)}
        disabled={isCommitting || isGenerating}
      />
      <textarea
        aria-label="Commit description"
        placeholder="Description (optional)"
        rows={3}
        className="w-full resize-none bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        disabled={isCommitting || isGenerating}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full h-8 text-xs gap-2"
        onClick={() => void onGenerateMessage()}
        disabled={!canGenerate}
        title={
          stagedCount === 0
            ? 'Stage files to generate a commit message'
            : !hasUsableAgent
              ? 'Configure and select an ACP agent'
              : 'Generate a commit message from staged changes'
        }
      >
        <Sparkles size={14} className={cn(isGenerating && 'animate-pulse')} />
        {isGenerating ? 'Generating...' : 'Generate message'}
      </Button>
      <label
        className={cn(
          'flex items-center gap-2 text-2xs select-none',
          commitContext?.hasHead
            ? 'text-muted-foreground cursor-pointer'
            : 'text-muted-foreground/40 cursor-not-allowed'
        )}
        title={
          commitContext?.hasHead
            ? 'Amend the last commit instead of creating a new one'
            : 'No commit to amend yet'
        }
      >
        <input
          type="checkbox"
          className="h-3 w-3 accent-primary"
          checked={amend}
          onChange={onToggleAmend}
          disabled={!commitContext?.hasHead || isCommitting || isGenerating}
        />
        Amend last commit
      </label>
      <Button
        variant="default"
        size="sm"
        className="w-full h-8 text-xs gap-2"
        onClick={onCommit}
        disabled={!canCommit}
        title={
          amend
            ? 'Amend the last commit'
            : stagedCount === 0
              ? 'Stage files to commit'
              : 'Commit staged changes'
        }
      >
        <GitCommit size={14} />
        {isCommitting
          ? 'Committing...'
          : amend
            ? 'Amend commit'
            : commitContext?.branch
              ? `Commit to ${commitContext.branch}`
              : 'Commit'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="w-full h-8 text-xs gap-2"
        onClick={onPush}
        disabled={!canPush}
        title={
          !onBranch
            ? 'Not on a branch (detached HEAD)'
            : !commitContext?.hasUpstream
              ? 'Publish this branch to origin'
              : ahead > 0
                ? 'Push commits to the remote'
                : 'Nothing to push — up to date with the remote'
        }
      >
        <ArrowUp size={14} className={cn(isPushing && 'animate-pulse')} />
        {isPushing ? 'Pushing...' : pushLabel}
        {behind > 0 && <span className="text-3xs tabular-nums text-warning">↓{behind}</span>}
      </Button>
    </div>
  )
}

/**
 * Confirmation for amending a commit that already matches upstream — rewrites
 * published history and needs a force-push. Rendered at the panel root so it
 * stays mounted across the mobile file-list/diff-view swap.
 */
export function AmendCommitDialog({
  isOpen,
  isLoading,
  onConfirm,
  onCancel
}: {
  isOpen: boolean
  isLoading: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      variant="danger"
      title="Amend pushed commit"
      message="The last commit appears to already be pushed. Amending rewrites published history and will require a force-push to update the remote. Continue?"
      confirmLabel="Amend anyway"
      isLoading={isLoading}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
