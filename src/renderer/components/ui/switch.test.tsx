import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch, switchClasses } from './switch'

afterEach(cleanup)

describe('Switch', () => {
  it('reads per-theme switch tokens instead of fixed fills', () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Auto save" checked={false} onCheckedChange={onCheckedChange} />)
    const sw = screen.getByRole('switch', { name: 'Auto save' })
    expect(sw.className).toContain('switch-track')
    expect(sw.className).not.toContain('bg-foreground')
    const thumb = sw.querySelector('span')?.className ?? ''
    expect(thumb).toContain('switch-thumb')
    // ring-/shadow- utilities would override the .switch-thumb box-shadow token.
    expect(thumb).not.toMatch(/(^|\s)(ring|shadow)-/)
    expect(sw.className).toContain('h-5 w-9')
    expect(sw.className).toContain('focus-visible:ring-focus-ring')
    expect(sw.className).not.toContain('primary')
    fireEvent.click(sw)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})

describe('Switch size', () => {
  it('defaults to 36x20 with a 16px thumb', () => {
    render(<Switch aria-label="On" />)
    const root = screen.getByRole('switch', { name: 'On' })
    expect(root).toHaveClass('h-5', 'w-9')
    expect(root.firstElementChild).toHaveClass('size-4', 'data-[state=checked]:translate-x-4')
  })

  it('size="sm" is 28x16 with a 12px thumb', () => {
    render(<Switch aria-label="On" size="sm" />)
    const root = screen.getByRole('switch', { name: 'On' })
    expect(root).toHaveClass('h-4', 'w-7')
    expect(root).not.toHaveClass('h-5')
    expect(root.firstElementChild).toHaveClass('size-3', 'data-[state=checked]:translate-x-3')
  })

  it('switchClasses gives a drawn switch the same track and thumb', () => {
    const { track, thumb } = switchClasses('sm')
    expect(track).toContain('switch-track')
    expect(track).toContain('h-4 w-7')
    expect(thumb).toContain('switch-thumb')
    expect(thumb).toContain('size-3')
  })
})
