import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolStrip } from './ToolStrip'

function renderStrip(onOpen = vi.fn()) {
  render(
    <ToolStrip aria-label="Tools" data-testid="strip">
      <ToolStrip.Group data-testid="top">
        <ToolStrip.Button label="Explorer" active icon={<svg data-testid="glyph" />} />
        <ToolStrip.Button
          label="Changes"
          onClick={onOpen}
          icon={<svg />}
          badge={<span data-testid="badge">4</span>}
        />
      </ToolStrip.Group>
      <ToolStrip.Spacer data-testid="spacer" />
      <ToolStrip.Group className="pb-2" data-testid="bottom">
        <ToolStrip.Button label="New terminal" shortcut="Ctrl+T" icon={<svg />} />
      </ToolStrip.Group>
    </ToolStrip>
  )
}

describe('ToolStrip', () => {
  it('is a 44px vertical toolbar with a 0.5px start hairline (Paper "Tool strip")', () => {
    renderStrip()
    const strip = screen.getByRole('toolbar', { name: 'Tools' })
    expect(strip).toHaveAttribute('aria-orientation', 'vertical')
    expect(strip).toHaveClass(
      'w-11',
      'pt-1.5',
      'border-l-[0.5px]',
      'border-border',
      'bg-background'
    )
  })

  it('stacks groups 4px apart and pushes the pinned group to the bottom', () => {
    renderStrip()
    expect(screen.getByTestId('top')).toHaveClass('flex-col', 'gap-1')
    expect(screen.getByTestId('spacer')).toHaveClass('flex-1')
    expect(screen.getByTestId('spacer')).toHaveAttribute('aria-hidden')
    expect(screen.getByTestId('bottom')).toHaveClass('pb-2')
  })

  it('renders 32px radius-8 buttons; the open one is the keycap', () => {
    renderStrip()
    const explorer = screen.getByRole('button', { name: 'Explorer' })
    const changes = screen.getByRole('button', { name: 'Changes' })
    for (const button of [explorer, changes]) expect(button).toHaveClass('size-8', 'rounded-lg')
    expect(explorer).toHaveClass('keycap', 'text-foreground')
    expect(changes).not.toHaveClass('keycap')
    expect(explorer).toContainElement(screen.getByTestId('glyph'))
  })

  it('puts the badge inside its button and forwards clicks', () => {
    const onOpen = vi.fn()
    renderStrip(onOpen)
    const changes = screen.getByRole('button', { name: 'Changes' })
    expect(changes).toContainElement(screen.getByTestId('badge'))
    fireEvent.click(changes)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('opens the tooltip on the left with the label and the shortcut', async () => {
    renderStrip()
    fireEvent.focus(screen.getByRole('button', { name: 'New terminal' }))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('New terminal')
    expect(tooltip).toHaveTextContent('Ctrl+T')
    expect(document.querySelector('[data-side="left"]')).not.toBeNull()
  })
})
