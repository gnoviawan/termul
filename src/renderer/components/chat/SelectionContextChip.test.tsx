import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SelectionContextChip } from './SelectionContextChip'

describe('SelectionContextChip', () => {
  it('renders the full-text tooltip outside a clipping scroll container', async () => {
    render(
      <TooltipProvider>
        <div data-testid="scroller" style={{ overflow: 'hidden' }}>
          <SelectionContextChip
            index={1}
            context={{ text: 'The whole selected text' }}
            tabIndex={0}
          />
        </div>
      </TooltipProvider>
    )
    fireEvent.focus(screen.getByRole('note', { name: 'Context 1: The whole selected text' }))
    const tooltip = await waitFor(() => screen.getByRole('tooltip'))
    expect(screen.getByTestId('scroller').contains(tooltip)).toBe(false)
  })
})
