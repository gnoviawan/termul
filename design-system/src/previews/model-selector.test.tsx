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

  // QA: after a pick on Cursor, a Cursor favorite opened from the Claude Agent
  // tab took two clicks (or two Enters, the same button activation). The first
  // only moved the rail back.
  it('a Cursor favorite picked from the Claude Agent tab after an earlier pick lands in one click', async () => {
    render(
      <TooltipProvider>
        <ModelSelectorV2Composer />
      </TooltipProvider>
    )
    const trigger = screen.getByTestId('agent-model-selector-trigger')
    fireEvent.click(trigger)
    await screen.findByTestId('selector-list')
    fireEvent.click(screen.getByRole('button', { name: 'Composer 2' }))
    expect(trigger.textContent).toContain('Composer 2')

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    const search = screen.getByLabelText('Search models and agents')
    const favorite = screen.getByRole('button', {
      name: 'Claude 4.6 Sonnet Thinking (Max Mode) · Cursor'
    })
    fireEvent.click(favorite)
    // Same panel throughout (no remount), and it stays open, as in the app.
    expect(screen.getByLabelText('Search models and agents')).toBe(search)

    expect(trigger.textContent).toContain('Claude 4.6 Sonnet Thinking (Max Mode)')
    expect(screen.getByRole('tab', { name: 'Cursor', selected: true })).toBeInTheDocument()
  })
})
