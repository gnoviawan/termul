import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Search } from '@/components/icons'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  RailChatGroup,
  RailChatIcon,
  RailChatItem,
  RailChatList,
  RailChatRow,
  RailChatTitle,
  RailShowMore
} from './rail-chats'
import { RailNav, RailNavRow } from './rail-nav'

describe('RailNav / RailNavRow', () => {
  function renderNav(row: Partial<React.ComponentProps<typeof RailNavRow>> = {}) {
    const onClick = vi.fn()
    render(
      <TooltipProvider>
        <RailNav data-testid="nav">
          <RailNavRow
            label="Search"
            icon={<Search />}
            shortcut="Ctrl+K"
            onClick={onClick}
            {...row}
          />
        </RailNav>
      </TooltipProvider>
    )
    return { onClick, button: screen.getByRole('button', { name: row.name ?? 'Search' }) }
  }

  it('lays out the section with 1px row gaps and 8/8/10 padding', () => {
    renderNav()
    expect(screen.getByTestId('nav')).toHaveClass('gap-px', 'px-2', 'pt-2', 'pb-2.5')
  })

  it('renders a 28px row with a 14px icon, the fading label and no Kbd chip', () => {
    const { button } = renderNav()
    expect(button).toHaveClass('h-7', 'px-3', 'gap-2', 'text-xs', 'text-secondary-foreground')
    expect(button.querySelector('kbd')).toBeNull()
    expect(button.querySelector('[data-rail-icon-column]')).toHaveClass('size-3.5')
    expect(within(button).getByText('Search')).toHaveClass('fade-end', 'min-w-0', 'flex-1')
  })

  it('shows the shortcut in the tooltip and calls onClick', async () => {
    const { button, onClick } = renderNav()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    fireEvent.focus(button)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Search')
    expect(tooltip.querySelector('kbd')).toHaveTextContent('Ctrl+K')
  })

  it('disables the row and keeps the hint in the tooltip', async () => {
    const { button, onClick } = renderNav({ disabled: true, hint: 'Open a project first' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.focus(button.parentElement as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Open a project first')
  })

  it('marks a pressed row with the keycap', () => {
    const { button } = renderNav({ pressed: true })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveClass('keycap')
  })

  it('forwards the ref to the button', () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(
      <TooltipProvider>
        <RailNavRow ref={ref} label="Search" icon={<Search />} />
      </TooltipProvider>
    )
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Search' }))
  })
})

function ChatGroup({
  total,
  openIndex,
  pinOpen = false
}: {
  total: number
  openIndex?: number
  pinOpen?: boolean
}) {
  return (
    <RailChatGroup total={total} pinnedIndex={pinOpen ? openIndex : undefined}>
      <RailChatList aria-label="Chats in Alpha">
        {Array.from({ length: total }, (_, index) => (
          <RailChatItem key={`chat-${index}`} index={index}>
            <RailChatRow open={index === openIndex} aria-label={`Chat ${index}`}>
              <RailChatIcon>*</RailChatIcon>
              <RailChatTitle>{`Chat ${index}`}</RailChatTitle>
              <span data-testid={`trail-${index}`}>2d</span>
            </RailChatRow>
          </RailChatItem>
        ))}
      </RailChatList>
      <RailShowMore />
    </RailChatGroup>
  )
}

describe('RailChatGroup parts', () => {
  const rows = () =>
    within(screen.getByRole('list', { name: 'Chats in Alpha' })).getAllByRole('button')

  it('renders a list of 30px rows with the title fade and the trail', () => {
    render(<ChatGroup total={2} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    const [first] = rows()
    expect(first).toHaveClass('h-7.5', 'pl-8.75', 'pr-3', 'gap-2.25')
    expect(within(first).getByText('Chat 0')).toHaveClass('fade-end', 'text-secondary-foreground')
    expect(within(first).getByTestId('trail-0')).toBeInTheDocument()
  })

  it('shows five chats, then expands in place with Show N more and collapses with Show less', () => {
    render(<ChatGroup total={8} />)
    expect(rows()).toHaveLength(5)
    const more = screen.getByRole('button', { name: 'Show 3 more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(more).toHaveClass('h-7', 'pl-14', 'text-muted-foreground')

    fireEvent.click(more)
    expect(rows()).toHaveLength(8)
    const less = screen.getByRole('button', { name: 'Show less' })
    expect(less).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(less)
    expect(rows()).toHaveLength(5)
  })

  it('keeps the open chat visible past the limit and leaves it out of the Show N more count', () => {
    render(<ChatGroup total={8} openIndex={6} pinOpen />)
    expect(rows()).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Chat 6' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeInTheDocument()
  })

  it('has no Show more when every chat fits', () => {
    render(<ChatGroup total={5} />)
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull()
  })

  it('marks the open chat with the keycap and aria-current', () => {
    render(<ChatGroup total={3} openIndex={1} />)
    const [first, open] = rows()
    expect(open).toHaveAttribute('aria-current', 'true')
    expect(open).toHaveClass('keycap')
    expect(first).not.toHaveAttribute('aria-current')
    expect(first).not.toHaveClass('keycap')
  })

  it('throws when a part is used outside the group', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<RailShowMore />)).toThrow(
      'RailShowMore must be used inside <RailChatGroup>'
    )
    vi.restoreAllMocks()
  })
})
