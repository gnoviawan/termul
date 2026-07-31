import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentCapabilitiesBadge } from './AgentCapabilitiesBadge'

describe('AgentCapabilitiesBadge', () => {
  it('stays hidden when no renderer-supported capability is advertised', () => {
    const { container } = render(<AgentCapabilitiesBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it('summarizes supported prompt and MCP transports without inventing unsupported features', async () => {
    render(
      <TooltipProvider>
        <AgentCapabilitiesBadge
          image
          audio
          embeddedContext
          mcpCapabilities={{ http: true, sse: true }}
        />
      </TooltipProvider>
    )

    const trigger = screen.getByLabelText(
      'Agent capabilities: Image prompts, Audio prompts (attachment unavailable), Embedded files, HTTP MCP, SSE MCP'
    )
    expect(trigger).toHaveTextContent('5')
    fireEvent.pointerEnter(trigger)
    await waitFor(() => {
      expect(screen.getByText('Agent capabilities')).toBeInTheDocument()
      expect(screen.getByText('Image prompts')).toBeInTheDocument()
      expect(screen.getByText('Embedded files')).toBeInTheDocument()
      expect(screen.getByText('HTTP MCP')).toBeInTheDocument()
      expect(screen.getByText('SSE MCP')).toBeInTheDocument()
      expect(screen.getByText('Audio prompts (attachment unavailable)')).toBeInTheDocument()
    })
  })
})
