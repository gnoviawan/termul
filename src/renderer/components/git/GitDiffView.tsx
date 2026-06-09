import type React from 'react'
import { useMemo } from 'react'
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

function InlineDiff({ diff }: { diff: string }): React.JSX.Element {
  const lines = useMemo(() => parseUnifiedDiffInline(diff), [diff])

  return (
    <div className="flex p-4 font-mono text-xs" style={{ tabSize: 4, MozTabSize: 4 }}>
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
      <div className="flex-1 overflow-x-auto whitespace-pre">
        {lines.map((line, i) => (
          <div key={i} className={lineClass(line.kind)}>
            {line.raw || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function SplitCell({
  cell,
  side,
  showLineNumber = true
}: {
  cell: ParsedDiffLine | null
  side: 'left' | 'right'
  showLineNumber?: boolean
}): React.JSX.Element {
  const lineNumber = side === 'left' ? cell?.oldLineNumber : cell?.newLineNumber

  return (
    <div className="flex">
      {showLineNumber && (
        <div className="flex-shrink-0 w-12 px-2 py-0.5 min-h-[1.25rem] text-right text-muted-foreground/60 select-none border-r border-border/40">
          {lineNumber !== undefined ? lineNumber : ''}
        </div>
      )}
      <div
        className={cn(
          'flex-1 px-2 py-0.5 min-h-[1.25rem] overflow-x-auto',
          cell ? lineClass(cell.kind) : 'bg-muted/5'
        )}
      >
        {cell ? cell.text || ' ' : '\u00a0'}
      </div>
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
          <div key={i} className="grid grid-cols-2 gap-0 whitespace-pre border-b border-border/20">
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
