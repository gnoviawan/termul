import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/git/GitDiffView', () => ({
  GitDiffView: () => <div data-testid="git-diff-view" />
}))

import { countDiffDelta, DiffPane } from './DiffPane'

const DIFF = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', '-old', '+new', '+more', ' same'].join(
  '\n'
)

function renderPane(overrides: Partial<React.ComponentProps<typeof DiffPane>> = {}) {
  const onDiffViewModeChange = vi.fn()
  render(
    <DiffPane
      selectedFile="src/lib/x.ts"
      selectedStaged={false}
      currentDiff={DIFF}
      diffViewMode="inline"
      onDiffViewModeChange={onDiffViewModeChange}
      onStageHunk={vi.fn()}
      onUnstageHunk={vi.fn()}
      {...overrides}
    />
  )
  return { onDiffViewModeChange }
}

describe('DiffPane', () => {
  it('counts added and removed lines without file headers', () => {
    expect(countDiffDelta(DIFF)).toEqual({ added: 2, removed: 1 })
  })

  it('header shows dir, file name, side tag and delta', () => {
    renderPane()
    expect(screen.getByText('src/lib/')).toBeInTheDocument()
    expect(screen.getByText('x.ts').className).toContain('font-medium')
    expect(screen.getByText('Working tree')).toBeInTheDocument()
    expect(screen.getByLabelText('2 added, 1 removed')).toHaveTextContent('+2 −1')
  })

  it('Inline | Split is a segmented track with a keycap active segment', () => {
    const { onDiffViewModeChange } = renderPane()
    const inline = screen.getByRole('button', { name: /Inline/ })
    const split = screen.getByRole('button', { name: /Split/ })
    expect(inline).toHaveAttribute('aria-pressed', 'true')
    expect(inline.className).toContain('keycap')
    expect(split).toHaveAttribute('aria-pressed', 'false')
    expect(split.className).not.toContain('keycap')
    fireEvent.click(split)
    expect(onDiffViewModeChange).toHaveBeenCalledWith('split')
  })

  it('mobile keeps the back button', () => {
    const onBack = vi.fn()
    renderPane({ variant: 'mobile', onBack, selectedStaged: true })
    fireEvent.click(screen.getByLabelText('Back to file list'))
    expect(onBack).toHaveBeenCalled()
    expect(screen.getByText('Staged')).toBeInTheDocument()
  })
})
