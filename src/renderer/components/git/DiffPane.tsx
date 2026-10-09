import { useMemo } from 'react'
import { GitDiffView } from '@/components/git/GitDiffView'
import { GitFileIcon, splitGitPath } from '@/components/git/rows'
import { AlignLeft, ChevronLeft, Columns2, FileText } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { type GitDiffViewMode, parseUnifiedDiffInline } from '@/lib/parse-unified-diff'
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

/** Desktop is the dense header; mobile grows the touch targets and drops the text. */
const CHROME = {
  desktop: {
    header: 'h-10 pl-4',
    track: 'h-7',
    segment: 'h-6',
    segmentIcon: 12,
    showText: true
  },
  mobile: {
    header: 'min-h-14 py-1 pl-1',
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

interface DiffPaneProps {
  /** Story 10: `mobile` uses touch-sized segments and hides the delta. */
  variant?: 'mobile'
  selectedFile: string
  selectedStaged: boolean
  /** `undefined`/`null` while loading. */
  currentDiff: string | null | undefined
  diffViewMode: GitDiffViewMode
  onDiffViewModeChange: (mode: GitDiffViewMode) => void
  /** Mobile stack only: shows the back-to-file-list button. */
  onBack?: () => void
  onStageHunk: React.ComponentProps<typeof GitDiffView>['onStageHunk']
  onUnstageHunk: React.ComponentProps<typeof GitDiffView>['onUnstageHunk']
}

/** Diff column of the Git panel: file header + Inline/Split track + diff body. */
export function DiffPane({
  variant,
  selectedFile,
  selectedStaged,
  currentDiff,
  diffViewMode,
  onDiffViewModeChange,
  onBack,
  onStageHunk,
  onUnstageHunk
}: DiffPaneProps) {
  const chrome = CHROME[variant ?? 'desktop']
  const { fileName, dirName } = splitGitPath(selectedFile)
  const delta = useMemo(
    () => (currentDiff && currentDiff.trim().length > 0 ? countDiffDelta(currentDiff) : null),
    [currentDiff]
  )

  return (
    <>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-b border-border bg-background pr-2',
          chrome.header
        )}
      >
        {onBack && (
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
            {selectedStaged ? 'Staged' : 'Working tree'}
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
        <DiffModeTrack mode={diffViewMode} onModeChange={onDiffViewModeChange} chrome={chrome} />
      </div>
      <ScrollArea className="flex-1 font-mono text-xs">
        {currentDiff === undefined || currentDiff === null ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Spinner size={16} decorative className="mr-2" />
            Loading diff...
          </div>
        ) : currentDiff.trim().length > 0 ? (
          <GitDiffView
            diff={currentDiff}
            mode={diffViewMode}
            filePath={selectedFile}
            diffSide={selectedStaged ? 'staged' : 'unstaged'}
            onStageHunk={onStageHunk}
            onUnstageHunk={onUnstageHunk}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
              <FileText size={18} />
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">No diff available</h3>
            <p className="text-xs max-w-[260px]">
              This file may be ignored by Git, unchanged relative to the selected base, or
              unavailable for diff preview.
            </p>
          </div>
        )}
      </ScrollArea>
    </>
  )
}
