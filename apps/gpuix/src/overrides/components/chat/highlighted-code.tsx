/**
 * GPUIX override of `components/chat/highlighted-code.tsx`.
 *
 * `HighlightedCode` (tool results) paints through native `<code>`, which
 * highlights in Rust with the transcript's syntax theme, instead of one span
 * per Shiki token inside a `<pre>`. `CodeTokens` (one diff line of Shiki
 * tokens) stays token-coloured: a line never wraps, so a row of `<text>` runs
 * lays out like the web's inline spans.
 */

import type { DiffTokenLine } from '@/lib/diff-highlight'
import { useColorTheme } from '@/stores/app-settings-store'
import { transcriptThemes } from '../../../chat/theme'
import { tw } from '../../../style/tw'

/** Shiki ids `resolveDiffLanguage` returns, under the alias GPUIX's `<code>` knows. */
const GRAMMARS: Record<string, string> = {
  typescript: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  jsx: 'javascript',
  bash: 'bash',
  shellscript: 'bash',
  rust: 'rust',
  python: 'python',
  json: 'json',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  toml: 'toml',
  markdown: 'markdown'
}

export function CodeTokens({ tokens }: { tokens: DiffTokenLine }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexShrink: 0 }}>
      {tokens.map((token, i) => (
        <text
          key={i}
          style={{
            whiteSpace: 'nowrap',
            color: token.dark ?? token.light ?? tw('text-foreground').color,
            ...(token.bold ? { fontWeight: 700 } : {})
          }}
        >
          {token.content}
        </text>
      ))}
    </div>
  )
}

interface HighlightedCodeProps {
  code: string
  language: string
  className?: string
}

export function HighlightedCode({ code, language, className }: HighlightedCodeProps) {
  const themes = transcriptThemes(useColorTheme())
  const grammar = GRAMMARS[language]
  const style = className ? tw(className) : {}
  return (
    <code
      code={code}
      {...(grammar ? { language: grammar } : {})}
      theme={{ ...themes.code, metrics: { codeTextSize: 12, codeLineHeight: 19.5 } }}
      style={style}
    />
  )
}
