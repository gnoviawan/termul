import { FileDiff } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import type { DiffContent } from '@/lib/acp-api'
import { type DiffTokenLine, highlightDiffText, resolveDiffLanguage } from '@/lib/diff-highlight'
import { cn } from '@/lib/utils'
import { type DiffLine, diffLineCounts, diffLines } from './tool-call-format'

interface DiffPreviewProps {
  diff: DiffContent
}

interface DiffHighlight {
  oldLines: DiffTokenLine[]
  newLines: DiffTokenLine[]
}

/**
 * Whole-file token streams for both sides of the diff. Either side over
 * budget (or any failure) falls back to plain text so the card never
 * half-highlights. Colors swap in without layout shift (same glyphs).
 */
function useDiffHighlight(
  path: string,
  oldText: string | null | undefined,
  newText: string
): DiffHighlight | null {
  const [highlight, setHighlight] = useState<DiffHighlight | null>(null)

  useEffect(() => {
    let cancelled = false
    setHighlight(null)
    const lang = resolveDiffLanguage(path)
    void Promise.all([
      highlightDiffText(oldText ?? '', lang),
      highlightDiffText(newText ?? '', lang)
    ]).then(([oldLines, newLines]) => {
      if (cancelled) return
      setHighlight(oldLines && newLines ? { oldLines, newLines } : null)
    })
    return () => {
      cancelled = true
    }
  }, [path, oldText, newText])

  return highlight
}

/**
 * Token stream for one diff row. Removed rows read the old file (they do not
 * exist in the new one); added and context rows read the new file so the
 * card matches the file as it looks now.
 */
function tokensForLine(highlight: DiffHighlight | null, line: DiffLine): DiffTokenLine | null {
  if (!highlight) return null
  if (line.type === 'removed') {
    return line.oldLine ? (highlight.oldLines[line.oldLine - 1] ?? null) : null
  }
  const index = line.newLine ?? line.oldLine
  return index ? (highlight.newLines[index - 1] ?? null) : null
}

function DiffLineTokens({ tokens }: { tokens: DiffTokenLine }): React.JSX.Element {
  return (
    <>
      {tokens.map((token, i) => (
        <span
          key={i}
          style={
            {
              '--dtok': token.light ?? 'inherit',
              '--dtok-dark': token.dark ?? token.light ?? 'inherit'
            } as CSSProperties
          }
          className={cn(
            'text-[var(--dtok)] dark:text-[var(--dtok-dark)]',
            token.italic && 'italic',
            token.bold && 'font-bold'
          )}
        >
          {token.content}
        </span>
      ))}
    </>
  )
}

/**
 * Minimal file-diff renderer (no external diff library). Shows the path, a
 * "+N −M" summary, gutter line numbers, and stacked removed/added lines with
 * full syntax highlighting over the usual red/green tints.
 */
export function DiffPreview({ diff }: DiffPreviewProps): React.JSX.Element {
  const lines = diffLines(diff)
  const { added, removed } = diffLineCounts(diff)
  const isNewFile = diff.oldText == null
  const highlight = useDiffHighlight(diff.path, diff.oldText, diff.newText)

  return (
    <div className="rounded border border-border/50 bg-background/50 text-xs">
      <div className="flex items-center gap-2 border-b border-border/40 px-2 py-1">
        <FileDiff size={12} className="text-muted-foreground" />
        <span className="truncate font-mono text-2xs" title={diff.path}>
          {diff.path}
        </span>
        {isNewFile && <span className="rounded bg-success/15 px-1 text-3xs text-success">new</span>}
        <span className="ml-auto font-mono text-2xs text-muted-foreground">
          <span className="text-success">+{added}</span>{' '}
          <span className="text-destructive">−{removed}</span>
        </span>
      </div>
      <div className="max-h-48 overflow-auto p-2 font-mono text-xs leading-relaxed">
        {lines.map((line, i) => {
          const tokens = tokensForLine(highlight, line)
          const number = line.newLine ?? line.oldLine
          return (
            <div
              key={i}
              className={cn(
                'flex',
                line.type === 'added' && 'bg-success/10 text-success',
                line.type === 'removed' && 'bg-destructive/10 text-destructive',
                line.type === 'context' &&
                  (line.text === '···'
                    ? 'select-none text-muted-foreground/50'
                    : 'text-muted-foreground')
              )}
            >
              <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/50">
                {number ?? ''}
              </span>
              <span className="w-4 shrink-0 select-none opacity-60">
                {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {tokens ? <DiffLineTokens tokens={tokens} /> : line.text}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
