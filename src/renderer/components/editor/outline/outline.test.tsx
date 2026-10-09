import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TocHeading } from '@/hooks/use-toc-headings'
import { formatDocumentStats, getDocumentStats } from './document-stats'
import { getTickWidth, OutlineTickStrip } from './OutlineTickStrip'
import {
  buildOutlineModel,
  formatDepthLabel,
  getMinHeadingLevel,
  getOutlineKeys
} from './outline-rows'
import { readScrollProgress } from './use-scroll-progress'

const headings: TocHeading[] = [
  { id: 'a', level: 1, text: 'Intro' },
  { id: 'b', level: 2, text: 'Setup' },
  { id: 'c', level: 3, text: 'Deep' },
  { id: 'd', level: 2, text: 'Setup' }
]

describe('outline-rows', () => {
  it('finds the shallowest heading level', () => {
    expect(getMinHeadingLevel(headings.slice(1))).toBe(2)
    expect(getMinHeadingLevel([])).toBe(6)
  })

  it('keys repeated headings by level, text and count', () => {
    expect(getOutlineKeys(headings)).toEqual(['1:Intro:0', '2:Setup:0', '3:Deep:0', '2:Setup:1'])
  })

  it('builds rows with depth, parents and collapsed children', () => {
    const open = buildOutlineModel(headings, new Set())
    expect(open.rows.map((row) => [row.heading.id, row.depth, row.hasChildren])).toEqual([
      ['a', 0, true],
      ['b', 1, true],
      ['c', 2, false],
      ['d', 1, false]
    ])
    expect(open.parentKeys).toEqual(['1:Intro:0', '2:Setup:0'])

    const collapsed = buildOutlineModel(headings, new Set(['2:Setup:0']))
    expect(collapsed.rows.map((row) => row.heading.id)).toEqual(['a', 'b', 'd'])
    expect(collapsed.rows[1].hiddenCount).toBe(1)
    expect(collapsed.visibleIdFor.get('c')).toBe('b')
  })

  it('formats the depth label with an en dash', () => {
    expect(formatDepthLabel(1)).toBe('H1')
    expect(formatDepthLabel(3)).toBe('H1–H3')
  })
})

describe('document-stats', () => {
  it('counts words outside frontmatter and code fences at 200 wpm', () => {
    const markdown = `---\ntitle: Ignore me\n---\n# Hello world\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n${'go '.repeat(399)}`
    const stats = getDocumentStats(markdown)
    expect(stats.words).toBe(401)
    expect(stats.minutes).toBe(3)
    expect(formatDocumentStats({ words: 1, minutes: 1 })).toBe('1 word · 1 min read')
  })
})

describe('readScrollProgress', () => {
  it('reports percent and hides when the document does not scroll', () => {
    const scrolling = { scrollHeight: 1100, clientHeight: 100, scrollTop: 420 } as HTMLElement
    expect(readScrollProgress(scrolling)).toEqual({ percent: 42, canScroll: true })

    const fits = { scrollHeight: 100, clientHeight: 100, scrollTop: 0 } as HTMLElement
    expect(readScrollProgress(fits).canScroll).toBe(false)
  })
})

describe('OutlineTickStrip', () => {
  it('sizes ticks by depth', () => {
    expect([0, 1, 2, 3].map(getTickWidth)).toEqual([14, 10, 6, 6])
  })

  it('renders one tick per heading, marks the active tick, and jumps on click', () => {
    const onHeadingClick = vi.fn()
    const { container } = render(
      <OutlineTickStrip headings={headings} activeHeadingId="b" onHeadingClick={onHeadingClick} />
    )

    const ticks = container.querySelectorAll('[data-outline-tick]')
    expect(ticks).toHaveLength(4)
    expect(ticks[1].firstElementChild).toHaveClass('bg-foreground')
    expect(ticks[0].firstElementChild).toHaveClass('bg-muted-foreground/50')

    fireEvent.click(ticks[2])
    expect(onHeadingClick).toHaveBeenCalledWith(headings[2])
  })

  it('opens the heading popover on focus', () => {
    render(<OutlineTickStrip headings={headings} onHeadingClick={vi.fn()} />)

    fireEvent.focus(screen.getByRole('button', { name: 'Show outline' }))
    expect(screen.getByRole('navigation', { name: 'On this page' })).toBeInTheDocument()
  })

  it('renders nothing without headings', () => {
    const { container } = render(<OutlineTickStrip headings={[]} onHeadingClick={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})
