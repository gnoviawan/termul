import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildHunkPatches, buildLinePatch, type HunkPatch } from '@/lib/build-hunk-patch'
import {
  getLanguageForFile,
  isParserReady,
  preloadParser,
  tokenizeLine
} from '@/lib/diff-syntax-highlight'
import {
  type GitDiffViewMode,
  type ParsedDiffLine,
  parseUnifiedDiffInline,
  parseUnifiedDiffSplit
} from '@/lib/parse-unified-diff'
import { cn } from '@/lib/utils'
import { computeWordDiff, getChangedRanges } from '@/lib/word-diff'

interface GitDiffViewProps {
  diff: string
  mode: GitDiffViewMode
  filePath?: string
  /**
   * Which side of the diff is displayed: working-tree changes (`unstaged`,
   * hunk action stages) or staged changes (`staged`, hunk action unstages).
   * When omitted, no per-hunk action is rendered.
   */
  diffSide?: 'unstaged' | 'staged'
  /** Per-hunk stage callback. Receives a single-hunk patch built from `diff`. */
  onStageHunk?: (patch: string) => void
  /** Per-hunk unstage callback. */
  onUnstageHunk?: (patch: string) => void
}

/** Which side a hunk action should target for the given diff side. */
type HunkAction = 'stage' | 'unstage'

function lineClass(kind: ParsedDiffLine['kind']): string {
  return cn(
    'px-2 py-0.5 min-h-[1.25rem]',
    kind === 'addition' && 'bg-green-500/10 text-green-400',
    kind === 'deletion' && 'bg-red-500/10 text-red-400',
    (kind === 'header' || kind === 'meta') && 'text-muted-foreground italic bg-muted/20',
    kind === 'context' && 'text-foreground/90'
  )
}

interface ChangedRange {
  start: number
  end: number
}

function parseStyleString(styleStr: string): React.CSSProperties {
  const props: Record<string, string> = {}
  const parts = styleStr.split(';')
  for (const part of parts) {
    const idx = part.indexOf(':')
    if (idx > 0) {
      const key = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (key && value) {
        props[key] = value
      }
    }
  }
  return props as React.CSSProperties
}

function shiftRanges(ranges: ChangedRange[], offset: number): ChangedRange[] {
  return ranges
    .map((r) => ({ start: Math.max(0, r.start - offset), end: r.end - offset }))
    .filter((r) => r.end > r.start)
}

function WordDiffSpan({
  text,
  kind
}: {
  text: string
  kind: 'deletion' | 'addition'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm',
        kind === 'deletion' && 'bg-red-500/25',
        kind === 'addition' && 'bg-green-500/25'
      )}
    >
      {text}
    </span>
  )
}

function renderWithWordDiff(
  text: string,
  changedRanges: ChangedRange[],
  kind: 'deletion' | 'addition'
): React.JSX.Element {
  if (changedRanges.length === 0) {
    return <>{text}</>
  }

  const result: React.ReactNode[] = []
  let pos = 0

  for (let i = 0; i < changedRanges.length; i += 1) {
    const range = changedRanges[i]
    if (range.start > pos) {
      result.push(text.slice(pos, range.start))
    }
    result.push(<WordDiffSpan key={i} text={text.slice(range.start, range.end)} kind={kind} />)
    pos = range.end
  }

  if (pos < text.length) {
    result.push(text.slice(pos))
  }

  return <>{result}</>
}

function HighlightedContent({
  text,
  language,
  changedRanges,
  kind
}: {
  text: string
  language: string
  changedRanges: ChangedRange[]
  kind: 'deletion' | 'addition' | 'context'
}): React.JSX.Element {
  const tokenSpans = tokenizeLine(text, language)
  const hasChanged = kind !== 'context' && changedRanges.length > 0

  if (tokenSpans.length === 0) {
    if (hasChanged) {
      return <>{renderWithWordDiff(text, changedRanges, kind)}</>
    }
    return <>{text}</>
  }

  return (
    <>
      {tokenSpans.map((span, i) => {
        const spanText = text.slice(span.start, span.end)
        const shifted = shiftRanges(changedRanges, span.start)
        const style = span.color ? parseStyleString(span.color) : undefined
        if (hasChanged) {
          return (
            <span key={i} style={style}>
              {renderWithWordDiff(spanText, shifted, kind)}
            </span>
          )
        }
        return (
          <span key={i} style={style}>
            {spanText}
          </span>
        )
      })}
    </>
  )
}

function computeInlineWordDiffRanges(
  lines: ParsedDiffLine[]
): Map<number, { removed: ChangedRange[]; added: ChangedRange[] }> {
  const result = new Map<number, { removed: ChangedRange[]; added: ChangedRange[] }>()
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.kind !== 'deletion') {
      i += 1
      continue
    }

    const deletionStart = i
    while (i < lines.length && lines[i].kind === 'deletion') {
      i += 1
    }
    const deletionEnd = i

    const additionStart = i
    while (i < lines.length && lines[i].kind === 'addition') {
      i += 1
    }
    const additionEnd = i

    const deletionCount = deletionEnd - deletionStart
    const additionCount = additionEnd - additionStart

    if (additionCount === 0) {
      continue
    }

    const pairCount = Math.min(deletionCount, additionCount)
    for (let p = 0; p < pairCount; p += 1) {
      const delLine = lines[deletionStart + p]
      const addLine = lines[additionStart + p]
      const segments = computeWordDiff(delLine.text, addLine.text)
      const removedRanges = getChangedRanges(segments, 'removed')
      const addedRanges = getChangedRanges(segments, 'added')
      result.set(deletionStart + p, { removed: removedRanges, added: [] })
      result.set(additionStart + p, { removed: [], added: addedRanges })
    }
  }

  return result
}

function HunkActionBar({
  action,
  onAction,
  selectedCount,
  onSelectedAction
}: {
  action: HunkAction
  onAction?: () => void
  selectedCount?: number
  onSelectedAction?: () => void
}): React.JSX.Element | null {
  if (!onAction && !onSelectedAction) return null
  const verb = action === 'stage' ? 'Stage' : 'Unstage'
  const buttonClass =
    'ml-2 inline-flex items-center rounded border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  return (
    <>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className={buttonClass}
          title={`${verb} hunk`}
          aria-label={`${verb} hunk`}
        >
          {verb} hunk
        </button>
      ) : null}
      {onSelectedAction && selectedCount && selectedCount > 0 ? (
        <button
          type="button"
          onClick={onSelectedAction}
          className={buttonClass}
          title={`${verb} selected lines`}
          aria-label={`${verb} selected lines`}
        >
          {verb} selected ({selectedCount})
        </button>
      ) : null}
    </>
  )
}

function InlineDiff({
  diff,
  filePath,
  language,
  hunkByIndex,
  action,
  onAction,
  selectedLines,
  onToggleLine
}: {
  diff: string
  filePath: string
  language: string
  hunkByIndex: Map<number, HunkPatch>
  action?: HunkAction
  onAction?: (patch: string) => void
  selectedLines: ReadonlySet<number>
  onToggleLine: (index: number) => void
}): React.JSX.Element {
  const lines = useMemo(() => parseUnifiedDiffInline(diff), [diff])
  const wordDiffRanges = useMemo(() => computeInlineWordDiffRanges(lines), [lines])

  // Per-hunk count of selected +/- lines (context lines are not selectable).
  const selectedCountByHunk = useMemo(() => {
    const counts = new Map<number, number>()
    for (const hunk of hunkByIndex.values()) {
      let count = 0
      for (const index of hunk.bodyLineIndices) {
        const raw = lines[index]?.raw ?? ''
        if (selectedLines.has(index) && (raw.startsWith('+') || raw.startsWith('-'))) {
          count += 1
        }
      }
      if (count > 0) counts.set(hunk.headerIndex, count)
    }
    return counts
  }, [hunkByIndex, lines, selectedLines])

  return (
    <div className="flex p-4 font-mono text-xs min-w-full" style={{ tabSize: 4, MozTabSize: 4 }}>
      {/* Phase 2 (#257): line-selection toggle gutter. Only +/- lines are
          selectable; the strip is separate from the line numbers so plain
          text selection (copy) is not hijacked. */}
      <div className="flex-shrink-0 select-none">
        {lines.map((line, i) => {
          const selectable = line.kind === 'deletion' || line.kind === 'addition'
          if (!selectable) {
            return <div key={`tog-${i}`} className="w-4 py-0.5 min-h-[1.25rem]" />
          }
          const selected = selectedLines.has(i)
          return (
            <button
              key={`tog-${i}`}
              type="button"
              onClick={() => onToggleLine(i)}
              aria-pressed={selected}
              aria-label={`${selected ? 'Clear' : 'Select'} line for partial staging`}
              className={cn(
                'w-4 py-0.5 min-h-[1.25rem] flex items-center justify-center text-[9px] leading-none cursor-pointer',
                selected
                  ? 'text-primary font-bold'
                  : 'text-transparent hover:text-muted-foreground/50'
              )}
            >
              {selected ? '●' : '·'}
            </button>
          )
        })}
      </div>
      {/* Line number gutters */}
      <div className="flex-shrink-0 select-none border-r border-border/40">
        {lines.map((line, i) => (
          <div
            key={`old-${i}`}
            className="px-2 py-0.5 min-h-[1.25rem] text-right text-muted-foreground/60"
          >
            {line.oldLineNumber !== undefined ? line.oldLineNumber : ''}
          </div>
        ))}
      </div>
      <div className="flex-shrink-0 select-none border-r border-border/40 mr-2">
        {lines.map((line, i) => (
          <div
            key={`new-${i}`}
            className="px-2 py-0.5 min-h-[1.25rem] text-right text-muted-foreground/60"
          >
            {line.newLineNumber !== undefined ? line.newLineNumber : ''}
          </div>
        ))}
      </div>

      {/* Code content */}
      <div className="flex-1 whitespace-pre-wrap break-words">
        {lines.map((line, i) => {
          const isHunkBody =
            line.kind === 'context' || line.kind === 'deletion' || line.kind === 'addition'
          const diffRanges = wordDiffRanges.get(i)
          const changedRanges =
            line.kind === 'deletion'
              ? (diffRanges?.removed ?? [])
              : line.kind === 'addition'
                ? (diffRanges?.added ?? [])
                : []
          const isSelected = selectedLines.has(i)

          return (
            <div
              key={i}
              className={cn(
                lineClass(line.kind),
                line.kind === 'deletion' && changedRanges.length > 0 && 'bg-red-500/15',
                line.kind === 'addition' && changedRanges.length > 0 && 'bg-green-500/15',
                isSelected && 'bg-primary/15 outline outline-1 outline-primary/40'
              )}
            >
              {isHunkBody ? (
                <HighlightedContent
                  text={line.text || ' '}
                  language={language}
                  changedRanges={changedRanges}
                  kind={line.kind as 'deletion' | 'addition' | 'context'}
                />
              ) : line.kind === 'header' && line.raw.startsWith('@@') ? (
                <span className="flex items-center">
                  <span className="flex-1">{line.raw}</span>
                  {action ? (
                    <HunkActionBar
                      action={action}
                      onAction={
                        hunkByIndex.has(i) && onAction
                          ? () => onAction(hunkByIndex.get(i)!.patch)
                          : undefined
                      }
                      selectedCount={selectedCountByHunk.get(i) ?? 0}
                      onSelectedAction={
                        hunkByIndex.has(i) && onAction
                          ? () => {
                              const partial = buildLinePatch(diff, filePath, i, selectedLines)
                              if (partial) onAction(partial)
                            }
                          : undefined
                      }
                    />
                  ) : null}
                </span>
              ) : (
                line.raw || ' '
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SplitCell({
  cell,
  side,
  language,
  changedRanges,
  showLineNumber = true
}: {
  cell: ParsedDiffLine | null
  side: 'left' | 'right'
  language: string
  changedRanges: ChangedRange[]
  showLineNumber?: boolean
}): React.JSX.Element {
  const lineNumber = side === 'left' ? cell?.oldLineNumber : cell?.newLineNumber

  return (
    <div className="flex">
      {showLineNumber && (
        <div className="flex-shrink-0 min-w-[3rem] px-2 py-0.5 min-h-[1.25rem] text-right text-muted-foreground/60 select-none border-r border-border/40">
          {lineNumber !== undefined ? lineNumber : ''}
        </div>
      )}
      <div
        className={cn(
          'flex-1 px-2 py-0.5 min-h-[1.25rem] whitespace-pre-wrap break-words',
          cell ? lineClass(cell.kind) : 'bg-muted/5',
          cell?.kind === 'deletion' && changedRanges.length > 0 && 'bg-red-500/15',
          cell?.kind === 'addition' && changedRanges.length > 0 && 'bg-green-500/15'
        )}
      >
        {cell ? (
          cell.kind === 'context' || cell.kind === 'deletion' || cell.kind === 'addition' ? (
            <HighlightedContent
              text={cell.text || ' '}
              language={language}
              changedRanges={changedRanges}
              kind={cell.kind as 'deletion' | 'addition' | 'context'}
            />
          ) : (
            cell.raw || ' '
          )
        ) : (
          '\u00a0'
        )}
      </div>
    </div>
  )
}

function SplitDiff({
  diff,
  language,
  hunkByRowIndex,
  action,
  onAction
}: {
  diff: string
  language: string
  hunkByRowIndex: Map<number, HunkPatch>
  action?: HunkAction
  onAction?: (patch: string) => void
}): React.JSX.Element {
  const rows = useMemo(() => parseUnifiedDiffSplit(diff), [diff])

  const splitWordDiffRanges = useMemo(() => {
    const leftRanges = new Map<number, ChangedRange[]>()
    const rightRanges = new Map<number, ChangedRange[]>()

    rows.forEach((row, i) => {
      if (row.fullWidth || !row.left || !row.right) return
      if (row.left.kind !== 'deletion' || row.right.kind !== 'addition') return

      const segments = computeWordDiff(row.left.text, row.right.text)
      leftRanges.set(i, getChangedRanges(segments, 'removed'))
      rightRanges.set(i, getChangedRanges(segments, 'added'))
    })

    return { leftRanges, rightRanges }
  }, [rows])

  return (
    <div className="p-4 font-mono text-xs" style={{ tabSize: 4, MozTabSize: 4 }}>
      {rows.map((row, i) =>
        row.fullWidth ? (
          <div
            key={i}
            className={cn(
              lineClass(row.fullWidth.kind),
              row.fullWidth.kind === 'header' &&
                row.fullWidth.raw.startsWith('@@') &&
                'flex items-center'
            )}
          >
            <span className="flex-1 whitespace-pre-wrap break-words">{row.fullWidth.raw}</span>
            {row.fullWidth.kind === 'header' &&
            row.fullWidth.raw.startsWith('@@') &&
            action &&
            hunkByRowIndex.has(i) &&
            onAction ? (
              <HunkActionBar
                action={action}
                onAction={() => onAction(hunkByRowIndex.get(i)!.patch)}
              />
            ) : null}
          </div>
        ) : (
          <div key={i} className="grid grid-cols-2 gap-0 border-b border-border/20">
            <SplitCell
              cell={row.left}
              side="left"
              language={language}
              changedRanges={splitWordDiffRanges.leftRanges.get(i) ?? []}
            />
            <SplitCell
              cell={row.right}
              side="right"
              language={language}
              changedRanges={splitWordDiffRanges.rightRanges.get(i) ?? []}
            />
          </div>
        )
      )}
    </div>
  )
}

export function GitDiffView({
  diff,
  mode,
  filePath,
  diffSide,
  onStageHunk,
  onUnstageHunk
}: GitDiffViewProps): React.JSX.Element {
  const language = useMemo(() => (filePath ? getLanguageForFile(filePath) : ''), [filePath])

  useEffect(() => {
    if (language) {
      void preloadParser(filePath ?? '')
    }
  }, [language, filePath])

  const [, setRenderTick] = useState(0)
  useEffect(() => {
    if (!language) return
    let mounted = true
    const checkReady = (): void => {
      if (!mounted) return
      if (isParserReady(language)) {
        setRenderTick((n) => n + 1)
      } else {
        setTimeout(checkReady, 50)
      }
    }
    setTimeout(checkReady, 50)
    return () => {
      mounted = false
    }
  }, [language])

  // Per-hunk stage/unstage (#257). Build single-hunk patches and index them
  // by line/row so each rendered `@@` header can look up its patch.
  const hunks = useMemo(() => buildHunkPatches(diff, filePath ?? ''), [diff, filePath])
  const hunkByInlineIndex = useMemo(() => {
    const m = new Map<number, HunkPatch>()
    for (const h of hunks) m.set(h.headerIndex, h)
    return m
  }, [hunks])
  const hunkBySplitRowIndex = useMemo(() => {
    const m = new Map<number, HunkPatch>()
    const rows = parseUnifiedDiffSplit(diff)
    let hunkIdx = 0
    rows.forEach((row, i) => {
      if (row.fullWidth?.raw.startsWith('@@') && hunks[hunkIdx]) {
        m.set(i, hunks[hunkIdx])
        hunkIdx += 1
      }
    })
    return m
  }, [diff, hunks])

  // The displayed side decides whether a hunk action stages or unstages.
  // Actions are only exposed when the matching callback is wired — a rendered
  // button without a callback would clear the selection without applying
  // anything (review feedback).
  const rawAction =
    diffSide === 'unstaged' ? onStageHunk : diffSide === 'staged' ? onUnstageHunk : undefined
  const action: HunkAction | undefined = rawAction
    ? diffSide === 'unstaged'
      ? 'stage'
      : 'unstage'
    : undefined

  // Phase 2 (#257): per-line selection for partial staging. Indices are
  // positions in the raw diff string — the same key `buildLinePatch` uses.
  // Selection resets whenever the diff changes (post-stage refetch) and is
  // cleared after any apply so stale toggles never linger.
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set())
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate reset-on-diff — selection must not survive a refetch
  useEffect(() => {
    setSelectedLines(new Set())
  }, [diff])
  const toggleLine = useCallback((index: number) => {
    setSelectedLines((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])
  const onAction = useCallback(
    (patch: string) => {
      setSelectedLines(new Set())
      rawAction?.(patch)
    },
    [rawAction]
  )

  if (mode === 'split') {
    return (
      <SplitDiff
        diff={diff}
        language={language}
        hunkByRowIndex={hunkBySplitRowIndex}
        action={action}
        onAction={onAction}
      />
    )
  }
  return (
    <InlineDiff
      diff={diff}
      filePath={filePath ?? ''}
      language={language}
      hunkByIndex={hunkByInlineIndex}
      action={action}
      onAction={onAction}
      selectedLines={selectedLines}
      onToggleLine={toggleLine}
    />
  )
}
