import { useMemo } from 'react'
import { GitDiffView } from '@/components/git/GitDiffView'
import { GitFileIcon, splitGitPath } from '@/components/git/rows'
import type { GitActions } from '@/components/git/use-git-actions'
import { AlertTriangle, AlignLeft, ChevronLeft, Columns2, FileText } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  type GitDiffViewMode,
  parseUnifiedDiffInline,
  saveGitDiffViewMode
} from '@/lib/parse-unified-diff'
import { cn } from '@/lib/utils'

/** Count added / removed lines in a unified diff (file headers excluded). */
export function countDiffDelta(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const { kind } of parseUnifiedDiffInline(diff)) {
    if (kind === 'addition') added++
    else if (kind === 'deletion') removed++
  }
  return { added, removed }
}

const VIEW_MODES: Array<{
  mode: GitDiffViewMode
  label: string
  title: string
  Icon: typeof AlignLeft
}> = [
  { mode: 'inline', label: 'Inline', title: 'Inline diff', Icon: AlignLeft },
  { mode: 'split', label: 'Split', title: 'Side-by-side diff', Icon: Columns2 }
]

/**
 * Desktop is the dense header; mobile grows the touch targets and drops the
 * text. Mobile `pr-14` reserves the sheet close target (absolute, top-right,
 * 44px on coarse pointers) so it never covers the header's right edge.
 */
const CHROME = {
  desktop: {
    header: 'h-10 pl-4 pr-2',
    track: 'h-7',
    segment: 'h-6',
    segmentIcon: 12,
    showText: true
  },
  mobile: {
    header: 'min-h-14 py-1 pl-1 pr-14',
    track: 'h-10',
    segment: 'h-9 min-w-9 justify-center',
    segmentIcon: 16,
    showText: false
  }
} as const

type Chrome = (typeof CHROME)[keyof typeof CHROME]

/** Inline | Split segmented track. */
function DiffModeTrack({
  mode,
  onModeChange,
  chrome
}: {
  mode: GitDiffViewMode
  onModeChange: (mode: GitDiffViewMode) => void
  chrome: Chrome
}) {
  return (
    <div
      role="group"
      aria-label="Diff view mode"
      className={cn(SEGMENTED_TRACK_CLASS, 'shrink-0', chrome.track)}
    >
      {VIEW_MODES.map(({ mode: value, label, title, Icon }) => {
        const active = mode === value
        return (
          <button
            key={value}
            type="button"
            title={title}
            aria-label={chrome.showText ? undefined : title}
            aria-pressed={active}
            onClick={() => onModeChange(value)}
            className={cn(segmentClass(active), 'gap-1.5', chrome.segment)}
          >
            <Icon size={chrome.segmentIcon} aria-hidden />
            {chrome.showText && label}
          </button>
        )
      })}
    </div>
  )
}

interface GitDiffPaneProps {
  /** Story 10: `mobile` uses touch-sized segments and hides the delta. */
  variant: 'desktop' | 'mobile'
  selectedFile: string
  selectedStaged: boolean
  /** `undefined`/`null` while the diff is loading. */
  currentDiff: string | null | undefined
  diffViewMode: GitDiffViewMode
  onDiffViewModeChange: (mode: GitDiffViewMode) => void
  /** Required unless `readOnly`. */
  onStageHunk?: GitActions['runStageHunk']
  /** Required unless `readOnly`. */
  onUnstageHunk?: GitActions['runUnstageHunk']
  /** Mobile only: returns to the file list. */
  onBack?: () => void
  /** A failed load: shown instead of the loading / empty states, with a Retry. */
  failure?: { detail: string; onRetry: () => void }
  /** Disables the hunk and selected-line controls (read-only server, write in flight). */
  controlsDisabled?: boolean
  /** Why the controls are disabled; shown under the header when set. */
  disabledReason?: string | null
  /** Replaces the Staged / Working tree chip (e.g. `at e44b917`). Display text only. */
  sideLabel?: string
  /** Replaces the "No diff available" text when the diff is empty (e.g. too large to load). */
  emptyNotice?: { title: string; detail?: string }
  /** No hunk or line actions, whatever the callbacks. Used for commit diffs. */
  readOnly?: boolean
}

/** Diff header (file, side label, delta, Inline | Split track) and diff body. */
export function GitDiffPane({
  variant,
  selectedFile,
  selectedStaged,
  currentDiff,
  diffViewMode,
  onDiffViewModeChange,
  onStageHunk,
  onUnstageHunk,
  onBack,
  failure,
  controlsDisabled = false,
  disabledReason = null,
  sideLabel,
  emptyNotice,
  readOnly = false
}: GitDiffPaneProps) {
  const isMobile = variant === 'mobile'
  const chrome = CHROME[variant]
  const { fileName, dirName } = splitGitPath(selectedFile)
  const delta = useMemo(
    () => (currentDiff && currentDiff.trim().length > 0 ? countDiffDelta(currentDiff) : null),
    [currentDiff]
  )

  const handleModeChange = (mode: GitDiffViewMode) => {
    onDiffViewModeChange(mode)
    saveGitDiffViewMode(mode)
  }

  return (
    <>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-b border-border bg-background',
          chrome.header
        )}
      >
        {isMobile && (
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="shrink-0"
            aria-label="Back to file list"
            onClick={onBack}
          >
            <ChevronLeft size={18} />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <GitFileIcon fileName={fileName} />
          <span
            className="flex min-w-0 items-baseline overflow-hidden text-xs"
            title={selectedFile}
          >
            {dirName && <span className="min-w-0 truncate text-muted-foreground">{dirName}/</span>}
            <span className="shrink-0 font-medium text-foreground">{fileName}</span>
          </span>
          <span className="flex h-5 shrink-0 items-center rounded-md border border-border px-1.5 text-2xs text-muted-foreground">
            {sideLabel ?? (selectedStaged ? 'Staged' : 'Working tree')}
          </span>
          {delta && chrome.showText && (
            <span
              className="shrink-0 text-2xs tabular-nums text-muted-foreground"
              aria-label={`${delta.added} added, ${delta.removed} removed`}
            >
              +{delta.added} −{delta.removed}
            </span>
          )}
        </div>
        <DiffModeTrack mode={diffViewMode} onModeChange={handleModeChange} chrome={chrome} />
      </div>
      {disabledReason && (
        <p className="border-b border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
          {disabledReason}
        </p>
      )}
      <ScrollArea className="flex-1 font-mono text-xs">
        {failure ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
              <AlertTriangle size={18} />
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">Couldn't load this diff.</h3>
            <p className="text-xs max-w-[320px] break-words mb-3">{failure.detail}</p>
            <Button type="button" variant="secondary" size="sm" onClick={failure.onRetry}>
              Retry
            </Button>
          </div>
        ) : currentDiff === undefined || currentDiff === null ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Spinner size={16} decorative className="mr-2" />
            Loading diff...
          </div>
        ) : currentDiff.trim().length > 0 ? (
          <fieldset
            disabled={controlsDisabled}
            aria-disabled={controlsDisabled || undefined}
            className="contents"
          >
            <GitDiffView
              diff={currentDiff}
              mode={diffViewMode}
              filePath={selectedFile}
              diffSide={readOnly ? undefined : selectedStaged ? 'staged' : 'unstaged'}
              onStageHunk={readOnly ? undefined : onStageHunk}
              onUnstageHunk={readOnly ? undefined : onUnstageHunk}
            />
          </fieldset>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
              <FileText size={18} />
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">
              {emptyNotice?.title ?? 'No diff available'}
            </h3>
            {(emptyNotice ? emptyNotice.detail : true) && (
              <p className="text-xs max-w-[260px]">
                {emptyNotice?.detail ??
                  'This file may be ignored by Git, unchanged relative to the selected base, or unavailable for diff preview.'}
              </p>
            )}
          </div>
        )}
      </ScrollArea>
    </>
  )
}
