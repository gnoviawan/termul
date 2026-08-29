import { fireEvent, render, screen } from '@testing-library/react'
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

describe('GitDiffView per-line staging (Phase 2, #257)', () => {
  const MULTI_LINE_DIFF = `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,4 @@
 const x = 1
-oldLine
-oldLine2
+newLine
+newLine2
 const y = 2
`

  it('toggles line selection via the gutter and stages only the selected lines', () => {
    const onStageHunk = vi.fn()
    render(
      <GitDiffView
        diff={MULTI_LINE_DIFF}
        mode="inline"
        filePath="foo.ts"
        diffSide="unstaged"
        onStageHunk={onStageHunk}
      />
    )

    // No partial action before any selection.
    expect(screen.queryByRole('button', { name: 'Stage selected lines' })).not.toBeInTheDocument()

    // Toggle gutter renders one control per +/- line, in diff order:
    // -oldLine, -oldLine2, +newLine, +newLine2.
    const toggles = screen.getAllByRole('button', { name: /line for partial staging/i })
    expect(toggles).toHaveLength(4)
    const [oldLineToggle, , , newLine2Toggle] = toggles

    fireEvent.click(oldLineToggle)
    fireEvent.click(newLine2Toggle)

    const selected = screen.getByRole('button', { name: 'Stage selected lines' })
    expect(selected.textContent).toContain('(2)')
    fireEvent.click(selected)

    expect(onStageHunk).toHaveBeenCalledTimes(1)
    const patch = onStageHunk.mock.calls[0][0] as string
    expect(patch).toContain('-oldLine\n')
    expect(patch).toContain('+newLine2\n')
    // Unselected deletion stays in the patch as context; unselected addition
    // is dropped entirely.
    expect(patch).toContain(' oldLine2\n')
    expect(patch).not.toContain('+newLine\n')
    expect(patch).not.toContain('-oldLine2\n')
    // Recomputed header counts: ctx(x,y,oldLine2)=3 + del 1 = old 4; 3 + add 1 = 4.
    expect(patch).toContain('@@ -1,4 +1,4 @@')
  })

  it('labels the partial action Unstage on the staged side', () => {
    render(
      <GitDiffView
        diff={MULTI_LINE_DIFF}
        mode="inline"
        filePath="foo.ts"
        diffSide="staged"
        onUnstageHunk={vi.fn()}
      />
    )
    const toggle = screen.getAllByRole('button', { name: /line for partial staging/i })[0]
    fireEvent.click(toggle)
    const button = screen.getByRole('button', { name: 'Unstage selected lines' })
    expect(button.textContent).toContain('(1)')
  })
})

describe('GitDiffView line-selection gating', () => {
  const MULTI_LINE_DIFF = `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,4 @@
 const x = 1
-oldLine
-oldLine2
+newLine
+newLine2
 const y = 2
`

  it('renders no selection toggles when the mutation callback is absent (mobile path)', () => {
    render(
      <GitDiffView diff={MULTI_LINE_DIFF} mode="inline" filePath="foo.ts" diffSide="unstaged" />
    )
    expect(screen.queryAllByRole('button', { name: /line for partial staging/i })).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Stage selected lines' })).not.toBeInTheDocument()
    // The hunk-level button is gated as well (no callback wired).
    expect(screen.queryByRole('button', { name: 'Stage hunk' })).not.toBeInTheDocument()
  })
})
