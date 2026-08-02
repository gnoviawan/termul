import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { McpBadge } from './McpBadge'

function openPopover(): void {
  fireEvent.click(screen.getByRole('button', { name: /mcp servers/i }))
}

describe('McpBadge (Story 1.8 — read-only MCP badge in composer)', () => {
  it('is hidden when no MCP servers are attached (count <= 0) and no server list', () => {
    const { container } = render(<McpBadge count={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the count when MCP servers are attached (count-only fallback)', () => {
    render(<McpBadge count={3} />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/MCP servers attached/i)).toBeInTheDocument()
  })

  it('renders 1+ (single server) without crashing', () => {
    render(<McpBadge count={1} />)
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})

describe('McpBadge popover (per-server enable/disable + status dot)', () => {
  const servers = [
    { id: 's1', name: 'Files', enabled: true },
    { id: 's2', name: 'Remote', enabled: false }
  ]

  it('renders at count 0 when servers exist (discoverable entry point)', () => {
    render(<McpBadge count={0} servers={servers} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: /mcp servers/i })).toBeInTheDocument()
  })

  it('lists each server with a status dot inside the popover', () => {
    render(
      <McpBadge
        count={2}
        servers={servers}
        onToggle={vi.fn()}
        probeStatus={{ s1: 'connected', s2: 'disconnected' }}
      />
    )
    openPopover()
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('Remote')).toBeInTheDocument()
    // Status dots expose their state via title (tooltip) — query by accessible
    // name through the title attribute on the dot span.
    expect(screen.getByTitle('Connected (Termul can reach this server)')).toBeInTheDocument()
    expect(
      screen.getByTitle('Disconnected (Termul could not reach this server)')
    ).toBeInTheDocument()
  })

  it('calls onToggle(id, false) when switching an enabled server to Off', () => {
    const onToggle = vi.fn()
    render(<McpBadge count={1} servers={servers} onToggle={onToggle} />)
    openPopover()
    // "Files" (s1) is enabled → its "Off" radio switches it off. Each row's
    // radios are scoped by their RadioGroup; click the "Off" radio input by id.
    const offRadio = document.getElementById('mcp-s1-off') as HTMLInputElement
    fireEvent.click(offRadio)
    expect(onToggle).toHaveBeenCalledWith('s1', false)
  })

  it('calls onToggle(id, true) when switching a disabled server to On', () => {
    const onToggle = vi.fn()
    render(<McpBadge count={1} servers={servers} onToggle={onToggle} />)
    openPopover()
    const onRadio = document.getElementById('mcp-s2-on') as HTMLInputElement
    fireEvent.click(onRadio)
    expect(onToggle).toHaveBeenCalledWith('s2', true)
  })

  it('discloses next-chat semantics + per-tool toggle coming soon', () => {
    render(<McpBadge count={1} servers={servers} onToggle={vi.fn()} />)
    openPopover()
    expect(screen.getByText(/takes effect on the next chat/i)).toBeInTheDocument()
    expect(screen.getByText(/per-tool toggle coming soon/i)).toBeInTheDocument()
  })

  it('shows the tool list (read-only) inside the collapsible on expand', () => {
    const onLoadTools = vi.fn()
    render(
      <McpBadge
        count={1}
        servers={servers}
        onToggle={vi.fn()}
        onLoadTools={onLoadTools}
        tools={{ s1: [{ name: 'read_file', description: 'read a file' }] }}
      />
    )
    openPopover()
    // Expanding the s1 collapsible triggers onLoadTools (auto-probe on first expand).
    fireEvent.click(screen.getByText(/1 tool/))
    expect(onLoadTools).toHaveBeenCalledWith('s1')
    expect(screen.getByText('read_file')).toBeInTheDocument()
    // Per-tool toggle UI must NOT be present (deferred — read-only).
    expect(screen.queryByRole('switch', { name: /read_file/i })).not.toBeInTheDocument()
  })

  it('shows "No tools available" for a connected server with an empty tool list', () => {
    render(
      <McpBadge
        count={1}
        servers={servers}
        onToggle={vi.fn()}
        probeStatus={{ s1: 'connected' }}
        tools={{ s1: [] }}
      />
    )
    openPopover()
    // s1 is connected but has 0 tools — expand its collapsible and confirm the
    // "No tools available" branch (NOT "Probing…" — the probe completed).
    // Two servers render "Show tools" triggers; pick the first (s1 = "Files").
    fireEvent.click(screen.getAllByText(/show tools/i)[0])
    expect(screen.getByText(/no tools available/i)).toBeInTheDocument()
    expect(screen.queryByText(/probing/i)).not.toBeInTheDocument()
  })
})
