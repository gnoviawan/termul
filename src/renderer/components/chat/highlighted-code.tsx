import { type CSSProperties, Fragment, useEffect, useState } from 'react'
import { type DiffTokenLine, highlightDiffText } from '@/lib/diff-highlight'
import { cn } from '@/lib/utils'

/** Dual-theme Shiki tokens for one line; colors flip with the app's `.dark` class. */
export function CodeTokens({ tokens }: { tokens: DiffTokenLine }): React.JSX.Element {
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
 * Per-line tokens for `code`, or null while loading, over budget, or for
 * plain text. Colors swap in without layout shift (same glyphs).
 */
function useHighlightedLines(code: string, language: string): DiffTokenLine[] | null {
  const [lines, setLines] = useState<DiffTokenLine[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setLines(null)
    if (language === 'plaintext') return
    void highlightDiffText(code, language).then((result) => {
      if (!cancelled) setLines(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return lines
}

interface HighlightedCodeProps {
  code: string
  /** Shiki language id, e.g. from `resolveDiffLanguage(path)`. */
  language: string
  className?: string
}

/** Read-only code block with the same Shiki themes as chat fences and diffs. */
export function HighlightedCode({
  code,
  language,
  className
}: HighlightedCodeProps): React.JSX.Element {
  const lines = useHighlightedLines(code, language)
  return (
    <pre className={className} data-language={language}>
      {lines
        ? lines.map((tokens, i) => (
            <Fragment key={i}>
              {i > 0 && '\n'}
              <CodeTokens tokens={tokens} />
            </Fragment>
          ))
        : code}
    </pre>
  )
}
