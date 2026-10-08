import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { McpBadge, McpServerList, McpServerRow } from './McpBadge'

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
    const btn = screen.getByRole('button', { name: /MCP servers — 3 attached/i })
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

  it('discloses that server changes take effect on the next chat', () => {
    render(<McpBadge count={1} servers={servers} onToggle={vi.fn()} />)
    openPopover()
    expect(screen.getByText(/takes effect on the next chat/i)).toBeInTheDocument()
    expect(screen.queryByText(/per-tool toggle coming soon/i)).not.toBeInTheDocument()
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
    const failedLine = screen.getByText(/Termul could not reach this server/i)
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
    const failedLine = screen.getByText(/Termul could not reach this server/i)
    expect(failedLine).toHaveAttribute('title', 'Termul could not reach this server.')
  })
})

describe('McpServerList (shared by the popover and the + sheet)', () => {
  const servers = [
    { id: 'github', name: 'github', enabled: true },
    { id: 'playwright', name: 'playwright', enabled: false }
  ]

  it('shows the attached summary, a row per server and the next-chat footnote', () => {
    render(
      <McpServerList
        count={2}
        servers={servers}
        onToggle={vi.fn()}
        probeStatus={{ github: 'connected', playwright: 'disconnected' }}
      />
    )

    expect(screen.getByText('2 attached to this session.')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('github')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Disable github' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable playwright' })).toBeInTheDocument()
    expect(screen.getByText('Takes effect on the next chat.')).toBeInTheDocument()
  })

  it('renders only the empty summary when there are no servers (no rows, no footnote)', () => {
    const { container } = render(<McpServerList count={0} servers={[]} />)

    expect(screen.getByText('No servers attached yet.')).toBeInTheDocument()
    expect(container.querySelector('ul')).toBeNull()
    expect(screen.queryByText('Takes effect on the next chat.')).not.toBeInTheDocument()
  })

  it('keeps the rows and footnote at count 0 when servers exist', () => {
    render(<McpServerList count={0} servers={servers} onToggle={vi.fn()} />)

    expect(screen.getByText('No servers attached yet.')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Takes effect on the next chat.')).toBeInTheDocument()
  })

  it('reports the toggle through onToggle and renders no switch without a handler', () => {
    const onToggle = vi.fn()
    const { unmount } = render(<McpServerList count={2} servers={servers} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Disable github' }))
    expect(onToggle).toHaveBeenCalledWith('github', false)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable playwright' }))
    expect(onToggle).toHaveBeenCalledWith('playwright', true)
    unmount()

    render(<McpServerList count={2} servers={servers} />)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('shows the unreachable copy for a disconnected server once its tools expand', () => {
    render(
      <McpServerList
        count={2}
        servers={servers}
        probeStatus={{ playwright: 'disconnected' }}
        probeError={{ playwright: 'connection refused' }}
      />
    )
    fireEvent.click(screen.getAllByText(/show tools/i)[1])
    expect(screen.getByText('Termul could not reach this server.')).toHaveAttribute(
      'title',
      'connection refused'
    )
  })

  it('keeps the 300px scroller by default and lets a host lift it with listClassName', () => {
    const base = render(<McpServerList count={2} servers={servers} />)
    const defaultList = base.container.querySelector('ul')
    expect(defaultList).toHaveClass('max-h-[300px]', 'overflow-y-auto', 'pr-2')
    base.unmount()

    const lifted = render(
      <McpServerList count={2} servers={servers} listClassName="max-h-fit overflow-visible pr-0" />
    )
    const liftedList = lifted.container.querySelector('ul')
    expect(liftedList).not.toHaveClass('max-h-[300px]')
    expect(liftedList).not.toHaveClass('overflow-y-auto')
    expect(liftedList).toHaveClass('max-h-fit', 'overflow-visible', 'pr-0')
  })

  it('exports McpServerRow so a host can render a single row', () => {
    render(
      <ul>
        <McpServerRow server={{ id: 'github', name: 'github' }} probeStatus="authRequired" />
      </ul>
    )
    expect(screen.getByText('github')).toBeInTheDocument()
    expect(screen.getByText('Needs auth')).toBeInTheDocument()
  })
})
