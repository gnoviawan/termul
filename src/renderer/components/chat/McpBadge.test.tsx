import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { McpBadge } from './McpBadge'

function openPopover(): void {
  fireEvent.click(screen.getByRole('button', { name: /mcp servers/i }))
}

describe('McpBadge (count-only fallback)', () => {
  it('is hidden when no MCP servers are attached (count <= 0) and no server list', () => {
    const { container } = render(<McpBadge count={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the count-only button when MCP servers are attached (no server list)', () => {
    render(<McpBadge count={3} />)
    const btn = screen.getByRole('button', { name: /3 MCP servers attached/i })
    expect(btn).toBeInTheDocument()
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

  it('renders the full management popover behind the trigger', () => {
    render(<McpBadge count={2} servers={servers} onToggle={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: /mcp servers/i })
    expect(trigger.className).toContain('size-8')

    fireEvent.click(trigger)
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('Remote')).toBeInTheDocument()
  })

  it('lists each server with a visible status label inside the popover', () => {
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
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
  })

  it('calls onToggle(id, false) when switching an enabled server to Off', () => {
    const onToggle = vi.fn()
    render(<McpBadge count={1} servers={servers} onToggle={onToggle} />)
    openPopover()
    const filesSwitch = screen.getByRole('switch', { name: /Disable Files/i }) as HTMLInputElement
    fireEvent.click(filesSwitch)
    expect(onToggle).toHaveBeenCalledWith('s1', false)
  })

  it('calls onToggle(id, true) when switching a disabled server to On', () => {
    const onToggle = vi.fn()
    render(<McpBadge count={1} servers={servers} onToggle={onToggle} />)
    openPopover()
    const remoteSwitch = screen.getByRole('switch', { name: /Enable Remote/i }) as HTMLInputElement
    fireEvent.click(remoteSwitch)
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
    fireEvent.click(screen.getByText(/1 tool/))
    expect(onLoadTools).toHaveBeenCalledWith('s1')
    expect(screen.getByText('read_file')).toBeInTheDocument()
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
    fireEvent.click(screen.getAllByText(/show tools/i)[0])
    expect(screen.getByText(/no tools available/i)).toBeInTheDocument()
    expect(screen.queryByText(/probing/i)).not.toBeInTheDocument()
  })

  it('surfaces the redacted probe error as the "Probe failed" tooltip', () => {
    render(
      <McpBadge
        count={1}
        servers={servers}
        onToggle={vi.fn()}
        probeStatus={{ s1: 'disconnected' }}
        probeError={{ s1: 'initialize failed: connection refused' }}
      />
    )
    openPopover()
    fireEvent.click(screen.getAllByText(/show tools/i)[0])
    const failedLine = screen.getByText(/probe failed — check the server config/i)
    expect(failedLine).toHaveAttribute('title', 'initialize failed: connection refused')
  })

  it('falls back to a generic tooltip when a disconnected probe has no error', () => {
    render(
      <McpBadge
        count={1}
        servers={servers}
        onToggle={vi.fn()}
        probeStatus={{ s2: 'disconnected' }}
      />
    )
    openPopover()
    fireEvent.click(screen.getAllByText(/show tools/i)[1])
    const failedLine = screen.getByText(/probe failed — check the server config/i)
    expect(failedLine).toHaveAttribute('title', 'Probe failed.')
  })
})
