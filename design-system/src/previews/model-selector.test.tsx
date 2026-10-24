import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ModelSelectorV2Composer } from './model-selector'

describe('ModelSelectorV2Composer', () => {
  it('opens the left-rail picker from the composer pill and a pick updates the pill', async () => {
    render(
      <TooltipProvider>
        <ModelSelectorV2Composer />
      </TooltipProvider>
    )
    const trigger = screen.getByTestId('agent-model-selector-trigger')
    expect(trigger.closest('[data-chat-composer]')).not.toBeNull()
    const before = trigger.textContent

    fireEvent.click(trigger)
    const rail = await screen.findByTestId('selector-list')
    expect(document.querySelector('[data-agent-rail]')?.getAttribute('data-agent-rail')).toBe(
      'left'
    )

    const row = within(rail)
      .getAllByRole('button')
      .find(
        (node) =>
          node.hasAttribute('data-selector-row') && node.getAttribute('aria-pressed') !== 'true'
      )
    expect(row).toBeDefined()
    const label = row?.querySelector('[data-row-name]')?.textContent ?? ''
    fireEvent.click(row as HTMLElement)

    expect(trigger.textContent).not.toBe(before)
    expect(trigger.textContent).toContain(label)
  })
})
