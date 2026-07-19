import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { McpBadge } from './McpBadge'

describe('McpBadge (Story 1.8 — read-only MCP badge in composer)', () => {
  it('is hidden when no MCP servers are attached (count <= 0)', () => {
    const { container } = render(<McpBadge count={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the count when MCP servers are attached', () => {
    render(<McpBadge count={3} />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/MCP servers attached/i)).toBeInTheDocument()
  })

  it('renders 1+ (single server) without crashing', () => {
    render(<McpBadge count={1} />)
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})
