import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IconActionButton, IconActionGroup } from './icon-action-button'

describe('IconActionButton', () => {
  it('renders compact control with expanded hit area and tooltip label as aria-label', () => {
    const onClick = vi.fn()
    render(
      <TooltipProvider>
        <IconActionButton label="Copy" onClick={onClick}>
          <span>icon</span>
        </IconActionButton>
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button).toHaveClass('size-6')
    expect(button.className).toContain('after:-inset-2.5')
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
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
})
