import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IconActionButton, IconActionGroup } from './icon-action-button'

describe('IconActionButton', () => {
  it('renders a 44px action slot with tooltip label as aria-label', () => {
    const onClick = vi.fn()
    render(
      <TooltipProvider>
        <IconActionButton label="Copy" onClick={onClick}>
          <span>icon</span>
        </IconActionButton>
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button).toHaveClass('size-11')
    expect(button.className).not.toContain('after:-inset')
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('keeps adjacent action hit regions from overlapping', () => {
    render(
      <TooltipProvider>
        <div className="flex gap-0.5">
          <IconActionButton label="Copy" onClick={() => {}}>
            <span>a</span>
          </IconActionButton>
          <IconActionButton label="Edit" onClick={() => {}}>
            <span>b</span>
          </IconActionButton>
        </div>
      </TooltipProvider>
    )
    const copy = screen.getByRole('button', { name: 'Copy' })
    const edit = screen.getByRole('button', { name: 'Edit' })
    expect(copy).toHaveClass('size-11')
    expect(edit).toHaveClass('size-11')
    // Layout slots are the buttons themselves — no expanded ::after hit targets.
    expect(copy.className).not.toMatch(/after:-inset/)
    expect(edit.className).not.toMatch(/after:-inset/)
  })

  it('uses muted text token when disabled instead of opacity', () => {
    render(
      <TooltipProvider>
        <IconActionButton label="Copy" onClick={() => {}} disabled>
          <span>icon</span>
        </IconActionButton>
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button).toHaveClass('disabled:text-muted-foreground/50')
    expect(button).not.toHaveClass('disabled:opacity-50')
  })

  it('renders a 24px (size-6) slot when size="sm"', () => {
    render(
      <TooltipProvider>
        <IconActionButton label="Copy" onClick={() => {}} size="sm">
          <span>icon</span>
        </IconActionButton>
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button).toHaveClass('size-6')
    expect(button).not.toHaveClass('size-11')
  })

  it('defaults to the 44px (size-11) slot when size is omitted', () => {
    render(
      <TooltipProvider>
        <IconActionButton label="Copy" onClick={() => {}}>
          <span>icon</span>
        </IconActionButton>
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button).toHaveClass('size-11')
    expect(button).not.toHaveClass('size-6')
  })
})

describe('IconActionGroup', () => {
  it('uses Streamdown action-pill chrome', () => {
    const { container } = render(
      <IconActionGroup>
        <span>child</span>
      </IconActionGroup>
    )
    expect(container.firstElementChild).toHaveClass('rounded-md')
    expect(container.firstElementChild).toHaveClass('border-sidebar')
  })

  it('applies dense (px-1 py-0.5) padding when dense is true', () => {
    const { container } = render(
      <IconActionGroup dense>
        <span>child</span>
      </IconActionGroup>
    )
    expect(container.firstElementChild).toHaveClass('px-1', 'py-0.5')
    expect(container.firstElementChild).not.toHaveClass('px-1.5', 'py-1')
  })

  it('uses default (px-1.5 py-1) padding when dense is omitted', () => {
    const { container } = render(
      <IconActionGroup>
        <span>child</span>
      </IconActionGroup>
    )
    expect(container.firstElementChild).toHaveClass('px-1.5', 'py-1')
  })
})
