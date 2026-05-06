import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TerminalSearchBar } from './TerminalSearchBar'

describe('TerminalSearchBar', () => {
  it('clears decorations when closed', () => {
    const onClearDecorations = vi.fn()
    const { rerender } = render(
      <TerminalSearchBar
        isOpen={true}
        onClose={vi.fn()}
        onFindNext={vi.fn(() => true)}
        onFindPrevious={vi.fn(() => true)}
        onClearDecorations={onClearDecorations}
      />,
    )

    rerender(
      <TerminalSearchBar
        isOpen={false}
        onClose={vi.fn()}
        onFindNext={vi.fn(() => true)}
        onFindPrevious={vi.fn(() => true)}
        onClearDecorations={onClearDecorations}
      />,
    )

    expect(onClearDecorations).toHaveBeenCalled()
  })

  it('drives next and previous search actions from keyboard interactions', () => {
    const onFindNext = vi.fn(() => true)
    const onFindPrevious = vi.fn(() => false)

    render(
      <TerminalSearchBar
        isOpen={true}
        onClose={vi.fn()}
        onFindNext={onFindNext}
        onFindPrevious={onFindPrevious}
        onClearDecorations={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('Search...')
    fireEvent.change(input, { target: { value: 'needle' } })
    expect(onFindNext).toHaveBeenCalledWith('needle')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onFindNext).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onFindPrevious).toHaveBeenCalledWith('needle')
  })

  it('shows no-match feedback when search misses', () => {
    render(
      <TerminalSearchBar
        isOpen={true}
        onClose={vi.fn()}
        onFindNext={vi.fn(() => false)}
        onFindPrevious={vi.fn(() => false)}
        onClearDecorations={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'missing' },
    })

    expect(screen.getByText('No matches')).toBeInTheDocument()
  })
})
