import { describe, expect, it, vi, beforeEach } from 'vitest'
import type React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { TableOfContents } from './TableOfContents'
import type { TocHeading } from '@/hooks/use-toc-headings'

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')

  const RadioGroupContext = React.createContext<((value: string) => void) | undefined>(undefined)

  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange
    }: {
      children: React.ReactNode
      onValueChange?: (value: string) => void
    }) => <RadioGroupContext.Provider value={onValueChange}><div>{children}</div></RadioGroupContext.Provider>,
    DropdownMenuRadioItem: ({
      children,
      value,
      onSelect
    }: {
      children: React.ReactNode
      value: string
      onSelect?: () => void
    }) => {
      const onValueChange = React.useContext(RadioGroupContext)

      return (
        <button
          type="button"
          data-value={value}
          onClick={() => {
            onSelect?.()
            onValueChange?.(value)
          }}
        >
          {children}
        </button>
      )
    }
  }
})

const headings: TocHeading[] = [
  { id: 'heading-line-1', level: 1, text: 'Title', line: 1 },
  { id: 'heading-line-3', level: 2, text: 'Section', line: 3 }
]

describe('TableOfContents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('renders an empty state when there are no headings', () => {
    render(
      <TableOfContents
        headings={[]}
        maxHeadingLevel={3}
        onHeadingClick={vi.fn()}
        onMaxHeadingLevelChange={vi.fn()}
      />
    )

    expect(screen.getByText('No headings found')).toBeInTheDocument()
  })

  it('renders heading items and highlights the active heading', () => {
    render(
      <TableOfContents
        headings={headings}
        activeHeadingId="heading-line-3"
        maxHeadingLevel={3}
        onHeadingClick={vi.fn()}
        onMaxHeadingLevelChange={vi.fn()}
      />
    )

    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Section').closest('button')).toHaveClass('bg-accent')
  })

  it('calls onHeadingClick when a heading is selected', () => {
    const onHeadingClick = vi.fn()

    render(
      <TableOfContents
        headings={headings}
        maxHeadingLevel={3}
        onHeadingClick={onHeadingClick}
        onMaxHeadingLevelChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByText('Section'))

    expect(onHeadingClick).toHaveBeenCalledWith(headings[1])
  })

  it('exposes full heading level range in settings', () => {
    render(
      <TableOfContents
        headings={headings}
        maxHeadingLevel={3}
        onHeadingClick={vi.fn()}
        onMaxHeadingLevelChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByLabelText('TOC settings'))

    expect(screen.getByText('H1-H1')).toBeInTheDocument()
    expect(screen.getByText('H1-H2')).toBeInTheDocument()
    expect(screen.getByText('H1-H6')).toBeInTheDocument()
  })

  it('calls onMaxHeadingLevelChange when a heading range is selected', () => {
    const onMaxHeadingLevelChange = vi.fn()

    render(
      <TableOfContents
        headings={headings}
        maxHeadingLevel={3}
        onHeadingClick={vi.fn()}
        onMaxHeadingLevelChange={onMaxHeadingLevelChange}
      />
    )

    fireEvent.click(screen.getByText('H1-H5'))

    expect(onMaxHeadingLevelChange).toHaveBeenCalledWith(5)
  })
})
