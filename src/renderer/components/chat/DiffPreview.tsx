import { FileDiff } from 'lucide-react'
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
import type { DiffContent } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { diffLineCounts, diffLines } from './tool-call-format'

interface DiffPreviewProps {
  diff: DiffContent
}

/**
 * Minimal file-diff renderer (no external diff library). Shows the path, a
 * "+N −M" summary, and stacked removed/added lines.
 */
export function DiffPreview({ diff }: DiffPreviewProps): React.JSX.Element {
  const t = useRuntimeTranslation('chat')
  const lines = diffLines(diff)
  const { added, removed } = diffLineCounts(diff)
  const isNewFile = diff.oldText == null

  return (
    <div className="rounded border border-border/50 bg-background/50 text-xs">
      <div className="flex items-center gap-2 border-b border-border/40 px-2 py-1">
        <FileDiff size={12} className="text-muted-foreground" />
        <span className="truncate font-mono text-2xs">{diff.path}</span>
        {isNewFile && (
          <span className="rounded bg-success/15 px-1 text-3xs text-success">
            {t('diff.newFile', 'new')}
          </span>
        )}
        <span className="ml-auto font-mono text-3xs text-muted-foreground">
          <span className="text-success">+{added}</span>{' '}
          <span className="text-destructive">−{removed}</span>
        </span>
      </div>
      <div className="max-h-48 overflow-auto p-2 font-mono text-2xs leading-snug">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap',
              line.type === 'added' && 'bg-success/10 text-success',
              line.type === 'removed' && 'bg-destructive/10 text-destructive',
              line.type === 'context' &&
                (line.text === '···'
                  ? 'select-none text-muted-foreground/50'
                  : 'text-muted-foreground')
            )}
          >
            <span className="select-none opacity-60">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
            </span>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  )
}
