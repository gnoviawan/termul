import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TocHeading } from '@/hooks/use-toc-headings'
import { TableOfContents } from './TableOfContents'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

const headings: TocHeading[] = [
  { id: 'h-1', level: 1, text: 'Title', line: 1 },
  { id: 'h-3', level: 2, text: 'Section', line: 3 },
  { id: 'h-5', level: 3, text: 'Detail', line: 5 },
  { id: 'h-7', level: 2, text: 'Other', line: 7 }
]

type Props = React.ComponentProps<typeof TableOfContents>

function renderToc(overrides: Partial<Props> = {}) {
  const props: Props = {
    headings,
    maxHeadingLevel: 3,
    onHeadingClick: vi.fn(),
    onMaxHeadingLevelChange: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onCollapsedKeysChange: vi.fn(),
    onHide: vi.fn(),
    onScrollToTop: vi.fn(),
    ...overrides
  }
  return { ...render(<TableOfContents {...props} />), props }
}

const rowButton = (text: string): HTMLButtonElement =>
  screen.getByText(text).closest('button') as HTMLButtonElement

describe('TableOfContents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the panel header on the document surface', () => {
    const { container } = renderToc()

    expect(screen.getByText('On this page')).toHaveClass('label-panel')
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass('bg-background')
    expect(root).not.toHaveClass('bg-card')
    expect(root).not.toHaveClass('border-l')
    expect(screen.getByRole('navigation', { name: 'On this page' })).toHaveClass('px-2', 'pb-2')
  })

  it('renders the empty state when there are no headings', () => {
    renderToc({ headings: [] })

    expect(screen.getByText('No headings yet')).toBeInTheDocument()
    expect(screen.getByText('Start a line with # and it shows up here.')).toBeInTheDocument()
  })

  it('renders the hidden state when all headings are deeper than the depth', () => {
    const { props } = renderToc({ headings: [], hiddenCount: 4, maxHeadingLevel: 2 })

    expect(screen.getByText('4 headings are hidden')).toBeInTheDocument()
    expect(screen.getByText('They are H3 and deeper.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show to H6' }))
    expect(props.onMaxHeadingLevelChange).toHaveBeenCalledWith(6)
  })

  it('renders a loading skeleton while headings are not parsed', () => {
    renderToc({ isLoading: true })

    expect(screen.getByRole('status', { name: 'Loading outline' })).toBeInTheDocument()
    expect(screen.queryByText('Title')).toBeNull()
  })

  it('marks the active row as a keycap with aria-current and no accent fill', () => {
    renderToc({ activeHeadingId: 'h-3' })

    const active = rowButton('Section')
    expect(active).toHaveAttribute('aria-current', 'location')
    expect(active).toHaveClass('keycap', 'text-foreground', 'h-7', 'text-xs')
    expect(active.className).not.toMatch(/bg-accent|bg-secondary|bg-primary/)
    expect(rowButton('Title')).not.toHaveAttribute('aria-current')
  })

  it('styles level 1 as medium secondary text and deeper rows as muted', () => {
    renderToc()

    expect(rowButton('Title')).toHaveClass('font-medium', 'text-secondary-foreground')
    expect(rowButton('Section')).toHaveClass('text-muted-foreground')
    expect(rowButton('Section')).not.toHaveClass('font-medium')
    expect(rowButton('Section').style.paddingLeft).toBe('18px')
    expect(rowButton('Detail').style.paddingLeft).toBe('30px')
  })

  it('calls onHeadingClick when a heading is selected', () => {
    const { props } = renderToc()

    fireEvent.click(screen.getByText('Section'))

    expect(props.onHeadingClick).toHaveBeenCalledWith(headings[1])
  })

  it('shows the depth chip with an en dash and picks a level from the track', () => {
    const { props } = renderToc()

    expect(screen.getByRole('button', { name: 'Heading depth H1–H3' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'H3' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'H3' })).toHaveClass('bg-foreground/10')
    expect(screen.getByRole('radio', { name: 'H5' })).toHaveClass('text-muted-foreground/60')

    fireEvent.click(screen.getByRole('radio', { name: 'H5' }))
    expect(props.onMaxHeadingLevelChange).toHaveBeenCalledWith(5)
  })

  it('collapses all parents, expands all, and hides the outline from the menu', () => {
    const { props, rerender } = renderToc()

    expect(screen.queryByRole('menuitem', { name: 'Expand all' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse all' }))
    expect(props.onCollapsedKeysChange).toHaveBeenCalledWith(['1:Title:0', '2:Section:0'])

    rerender(<TableOfContents {...props} collapsedKeys={['1:Title:0', '2:Section:0']} />)
    expect(screen.queryByRole('menuitem', { name: 'Collapse all' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expand all' }))
    expect(props.onCollapsedKeysChange).toHaveBeenLastCalledWith([])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide outline' }))
    expect(props.onHide).toHaveBeenCalledTimes(1)
  })

  it('hides children of a collapsed parent and moves the active mark to it', () => {
    renderToc({ collapsedKeys: ['2:Section:0'], activeHeadingId: 'h-5' })

    expect(screen.queryByText('Detail')).toBeNull()
    expect(rowButton('Section')).toHaveAttribute('aria-expanded', 'false')
    expect(rowButton('Section')).toHaveAttribute('aria-current', 'location')
  })

  it('toggles collapse from the chevron without jumping', () => {
    const { container, props } = renderToc()

    const toggles = container.querySelectorAll('[data-outline-toggle]')
    expect(toggles).toHaveLength(2)
    fireEvent.click(toggles[1])

    expect(props.onToggleCollapsed).toHaveBeenCalledWith('2:Section:0')
    expect(props.onHeadingClick).not.toHaveBeenCalled()
  })

  it('moves focus with arrow keys and collapses with ArrowLeft', () => {
    const { props } = renderToc({ activeHeadingId: 'h-1' })

    const title = rowButton('Title')
    expect(title).toHaveAttribute('tabindex', '0')
    expect(rowButton('Section')).toHaveAttribute('tabindex', '-1')

    title.focus()
    fireEvent.keyDown(title, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowButton('Section'))

    fireEvent.keyDown(rowButton('Section'), { key: 'End' })
    expect(document.activeElement).toBe(rowButton('Other'))

    fireEvent.keyDown(rowButton('Other'), { key: 'Home' })
    expect(document.activeElement).toBe(title)

    fireEvent.keyDown(title, { key: 'ArrowLeft' })
    expect(props.onToggleCollapsed).toHaveBeenCalledWith('1:Title:0')
  })

  it('shows read progress and a Top button only when the document scrolls', () => {
    const { props, rerender } = renderToc({ progress: { percent: 42, canScroll: true } })

    expect(screen.getByText('42% read')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Read progress' })).toHaveAttribute(
      'aria-valuenow',
      '42'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to top' }))
    expect(props.onScrollToTop).toHaveBeenCalledTimes(1)

    rerender(<TableOfContents {...props} progress={{ percent: 0, canScroll: false }} />)
    expect(screen.queryByText('0% read')).toBeNull()
  })
})
