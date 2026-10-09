import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './switch'

describe('Switch', () => {
  it('is neutral: foreground track when on, input track when off, no primary fill', () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Auto save" checked={false} onCheckedChange={onCheckedChange} />)
    const sw = screen.getByRole('switch', { name: 'Auto save' })
    expect(sw.className).toContain('data-[state=checked]:bg-foreground')
    expect(sw.className).toContain('data-[state=unchecked]:bg-input')
    expect(sw.className).toContain('h-5 w-9')
    expect(sw.className).toContain('focus-visible:ring-ring')
    expect(sw.className).not.toContain('primary')
    fireEvent.click(sw)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})
