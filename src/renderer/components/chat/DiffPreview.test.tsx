import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiffPreview } from './DiffPreview'

const diff = {
  path: 'src/app.ts',
  oldText: 'const a = 1\nconst b = 2\n',
  newText: 'const a = 1\nconst b = 3\n'
}

describe('DiffPreview', () => {
  it('renders path and change counts', () => {
    render(<DiffPreview diff={diff} />)
    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
  })

  it('shows new-side numbers for added lines and old-side for removed', () => {
    const { container } = render(<DiffPreview diff={diff} />)
    // context(a=1): 1 · removed(b=2): old 2 · added(b=3): new 2
    const gutters = [...container.querySelectorAll('.tabular-nums')].map((el) => el.textContent)
    expect(gutters).toEqual(['1', '2', '2'])
  })

  it('renders code text immediately (plain fallback) then swaps in tokens', async () => {
    const { container } = render(<DiffPreview diff={diff} />)
    expect(container.textContent).toContain('const b = 3')
    await waitFor(() => {
      const colored = [...container.querySelectorAll('span')].filter((span) =>
        span.style.getPropertyValue('--dtok')
      )
      expect(colored.length).toBeGreaterThan(0)
    })
    // Same glyphs after highlight — colors only, no layout shift.
    expect(container.textContent).toContain('const b = 3')
  })

  it('renders gap markers without numbers', () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const oldText = base.join('\n')
    const edited = [...base]
    edited[1] = 'line one changed'
    edited[28] = 'line twenty-eight changed'
    const { container } = render(
      <DiffPreview diff={{ path: 'a.txt', oldText, newText: edited.join('\n') }} />
    )
    expect(container.textContent).toContain('···')
  })
})
