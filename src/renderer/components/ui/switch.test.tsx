import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './switch'

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
