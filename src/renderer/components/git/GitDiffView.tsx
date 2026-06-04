import type React from 'react'
import { useMemo } from 'react'
import { highlightLine } from '@/lib/diff-syntax-highlight'
import {
  type GitDiffViewMode,
  type ParsedDiffLine,
  parseUnifiedDiffInline,
  parseUnifiedDiffSplit
} from '@/lib/parse-unified-diff'
import { cn } from '@/lib/utils'

interface GitDiffViewProps {
  diff: string
  mode: GitDiffViewMode
}

function lineClass(kind: ParsedDiffLine['kind']): string {
  return cn(
    'px-2 py-0.5 min-h-[1.25rem]',
    kind === 'addition' && 'bg-green-500/10 text-green-400',
    kind === 'deletion' && 'bg-red-500/10 text-red-400',
    (kind === 'header' || kind === 'meta') && 'text-muted-foreground italic bg-muted/20',
    kind === 'context' && 'text-foreground/90'
  )
}

function renderHighlighted(text: string): React.ReactNode[] {
  return highlightLine(text).map((token, i) => {
    if (token.type === 'plain') {
      return token.text
    }
    return (
      <span key={i} className={`hl-${token.type}`}>
        {token.text}
      </span>
    )
  })
}

function InlineDiff({ diff }: { diff: string }): React.JSX.Element {
  const lines = useMemo(() => parseUnifiedDiffInline(diff), [diff])

  return (
    <div className="p-4 whitespace-pre" style={{ tabSize: 4, MozTabSize: 4 }}>
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line.kind)}>
          {line.kind === 'context' || line.kind === 'addition' || line.kind === 'deletion'
            ? renderHighlighted(line.text || ' ')
            : line.raw || ' '}
        </div>
      ))}
    </div>
  )
}

function SplitCell({
  cell,
  side
}: {
  cell: ParsedDiffLine | null
  side: 'left' | 'right'
}): React.JSX.Element {
  const content = cell
    ? cell.kind === 'context' || cell.kind === 'addition' || cell.kind === 'deletion'
      ? renderHighlighted(cell.text || ' ')
      : cell.text || '\u00a0'
    : '\u00a0'

  return (
    <div
      className={cn(
        'px-2 py-0.5 min-h-[1.25rem] border-border/40 overflow-x-auto',
        side === 'left' && 'border-r',
        cell ? lineClass(cell.kind) : 'bg-muted/5'
      )}
    >
      {content}
    </div>
  )
}

function SplitDiff({ diff }: { diff: string }): React.JSX.Element {
  const rows = useMemo(() => parseUnifiedDiffSplit(diff), [diff])

  return (
    <div className="p-4 font-mono text-xs" style={{ tabSize: 4, MozTabSize: 4 }}>
      {rows.map((row, i) =>
        row.fullWidth ? (
          <div key={i} className={lineClass(row.fullWidth.kind)}>
            {row.fullWidth.raw}
          </div>
        ) : (
          <div key={i} className="grid grid-cols-2 gap-0 whitespace-pre">
            <SplitCell cell={row.left} side="left" />
            <SplitCell cell={row.right} side="right" />
          </div>
        )
      )}
    </div>
  )
}

export function GitDiffView({ diff, mode }: GitDiffViewProps): React.JSX.Element {
  if (mode === 'split') {
    return <SplitDiff diff={diff} />
  }
  return <InlineDiff diff={diff} />
}
