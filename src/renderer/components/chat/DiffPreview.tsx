import { diffLines, diffLineCounts } from './tool-call-format'
import { cn } from '@/lib/utils'
import { FileDiff } from 'lucide-react'
import type { DiffContent } from '@/lib/acp-api'

interface DiffPreviewProps {
  diff: DiffContent
}

/**
 * Minimal file-diff renderer (no external diff library). Shows the path, a
 * "+N −M" summary, and stacked removed/added lines.
 */
export function DiffPreview({ diff }: DiffPreviewProps): React.JSX.Element {
  const lines = diffLines(diff)
  const { added, removed } = diffLineCounts(diff)
  const isNewFile = !(diff.oldText && diff.oldText.length > 0)

  return (
    <div className="rounded border border-border/50 bg-background/50 text-xs">
      <div className="flex items-center gap-2 border-b border-border/40 px-2 py-1">
        <FileDiff size={12} className="text-muted-foreground" />
        <span className="truncate font-mono text-[11px]">{diff.path}</span>
        {isNewFile && (
          <span className="rounded bg-green-400/10 px-1 text-[10px] text-green-400">new</span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          <span className="text-green-400">+{added}</span>{' '}
          <span className="text-red-400">−{removed}</span>
        </span>
      </div>
      <pre className="max-h-48 overflow-auto p-2 font-mono text-[11px] leading-snug">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap',
              line.type === 'added' ? 'bg-green-400/10 text-green-300' : 'bg-red-400/10 text-red-300'
            )}
          >
            <span className="select-none opacity-60">{line.type === 'added' ? '+' : '−'} </span>
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}
