import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PopoverSearchBand } from './popover-search-band'

describe('PopoverSearchBand', () => {
  it('renders a labelled borderless input in a 40px hairline band', () => {
    render(
      <PopoverSearchBand
        value=""
        onChange={() => {}}
        placeholder="Search branches"
        ariaLabel="Search branches"
        inputClassName="h-full text-xs"
      />
    )
    const input = screen.getByRole('textbox', { name: 'Search branches' })
    expect(input).toHaveAttribute('placeholder', 'Search branches')
    expect(input).toHaveClass(
      'border-0',
      'bg-transparent',
      'h-full',
      'text-xs',
      'focus-visible:ring-1',
      'focus-visible:ring-ring'
    )
    expect(input.parentElement).toHaveClass('h-10', 'border-b', 'border-border')
  })

  it('reports the typed value', () => {
    const onChange = vi.fn()
    render(
      <PopoverSearchBand value="" onChange={onChange} placeholder="Search" ariaLabel="Search" />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'main' }
    })
    expect(onChange).toHaveBeenCalledWith('main')
  })

  it('takes focus when autoFocus is set', () => {
    render(
      <PopoverSearchBand
        value=""
        onChange={() => {}}
        placeholder="Search"
        ariaLabel="Search"
        autoFocus
      />
    )
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus()
  })
})
