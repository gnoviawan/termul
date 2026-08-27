import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitDiffView } from './GitDiffView'

// CAP-6 Row 5: GitDiffView renders a diff via the single consolidated static
// import on GitDiffView.tsx:3 (getLanguageForFile, tokenizeLine, preloadParser,
// isParserReady). The redundant dynamic imports that caused
// [INEFFECTIVE_DYNAMIC_IMPORT] were removed; this test guards that the
// consolidated import didn't break rendering.
//
// The async @codemirror/lang-* parser won't resolve synchronously in jsdom, so
// tokenizeLine returns [] and lines render as plain (un-tokenized) text. We
// assert the diff LINES are present, not syntax colors. preloadParser and
// isParserReady run for real — they no-op gracefully when the parser isn't
// ready.

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

const SAMPLE_DIFF = `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const x = 1
-oldLine
+newLine
 const y = 2
`

describe('GitDiffView', () => {
  it('renders diff lines in inline mode via the consolidated static import', () => {
    const { container } = render(<GitDiffView diff={SAMPLE_DIFF} mode="inline" filePath="foo.ts" />)

    const text = container.textContent ?? ''
    expect(text).toContain('oldLine')
    expect(text).toContain('newLine')
    expect(text).toContain('const x = 1')
    expect(text).toContain('const y = 2')
  })

  it('renders diff lines in split mode', () => {
    const { container } = render(<GitDiffView diff={SAMPLE_DIFF} mode="split" filePath="foo.ts" />)

    const text = container.textContent ?? ''
    expect(text).toContain('oldLine')
    expect(text).toContain('newLine')
    expect(text).toContain('const x = 1')
  })

  it('renders without a filePath (no language, no parser polling)', () => {
    const { container } = render(<GitDiffView diff={SAMPLE_DIFF} mode="inline" />)

    const text = container.textContent ?? ''
    expect(text).toContain('oldLine')
    expect(text).toContain('newLine')
  })
})
