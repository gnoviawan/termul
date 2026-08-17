import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { McpBadge } from './McpBadge'

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('McpBadge', () => {
  it('is hidden when no MCP servers are attached (count <= 0)', () => {
    const { container } = renderWithTooltip(<McpBadge count={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the MCP icon button with tooltip when servers are attached', () => {
    renderWithTooltip(<McpBadge count={3} />)
    expect(screen.getByRole('button', { name: /MCP servers — 3 attached/i })).toBeInTheDocument()
  })

  it('renders with singular label for 1 server', () => {
    renderWithTooltip(<McpBadge count={1} />)
    expect(screen.getByRole('button', { name: /MCP servers — 1 attached/i })).toBeInTheDocument()
  })
})
