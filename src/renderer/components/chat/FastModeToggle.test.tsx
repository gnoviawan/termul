import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import { FastModeToggle } from './FastModeToggle'

function fastMode(currentValue = 'off'): SessionConfigOption {
  return {
    id: 'fast_mode',
    name: 'Fast Mode',
    category: 'other',
    type: 'select',
    currentValue,
    description: null,
    options: [
      { value: 'on', name: 'On', description: null },
      { value: 'off', name: 'Off', description: null }
    ]
  }
}

describe('FastModeToggle', () => {
  it('renders a pressed lightning control when Fast Mode is on', () => {
    render(
      <TooltipProvider>
        <FastModeToggle option={fastMode('on')} disabled={false} onSelect={vi.fn()} />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Fast Mode' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button.className).toContain('text-warning')
  })

  it('toggles to the opposite value on click', () => {
    const onSelect = vi.fn()
    render(
      <TooltipProvider>
        <FastModeToggle option={fastMode('off')} disabled={false} onSelect={onSelect} />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Fast Mode' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith('on')
  })
})
