import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { McpServersSettings } from './McpServersSettings'

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

const saveMcpServer = vi.fn(async () => {})
const setMcpServerEnabled = vi.fn(async () => {})
const deleteMcpServer = vi.fn(async () => {})
const probeMcpServer = vi.fn(async () => {})
const loadMcpTools = vi.fn(async () => {})

function seedStore(): void {
  useAcpStore.setState({
    mcpServers: [],
    mcpProbeStatus: {},
    mcpProbeError: {},
    mcpTools: {},
    mcpToolsLoaded: {},
    mcpProbing: {},
    saveMcpServer,
    setMcpServerEnabled,
    deleteMcpServer,
    probeMcpServer,
    loadMcpTools
  })
}

describe('McpServersSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedStore()
  })

  it('creates a stdio server and serializes args and environment', async () => {
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Files' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText(/arguments/i), { target: { value: '-y\nserver' } })
    fireEvent.change(screen.getByLabelText(/environment/i), {
      target: { value: 'TOKEN=$TOKEN' }
    })
    fireEvent.click(save)
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stdio',
        name: 'Files',
        command: 'npx',
        args: ['-y', 'server'],
        env: [{ name: 'TOKEN', value: '$TOKEN' }],
        enabled: true
      })
    )
  })

  it('edits an HTTP server and exposes experimental ACP as disclosure only', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'http-1',
          type: 'http',
          name: 'Remote',
          url: 'https://old.test/mcp',
          enabled: true
        }
      ]
    })
    render(<McpServersSettings />)
    expect(screen.getByText(/experimental mcp-over-acp/i)).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /acp/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /edit remote/i }))
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.test/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'http-1', type: 'http', url: 'https://new.test/mcp' })
      )
    )
  })

  it('toggles and deletes existing servers', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 'one', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('switch', { name: /disable files/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete files/i }))
    await waitFor(() => expect(setMcpServerEnabled).toHaveBeenCalledWith('one', false))
    expect(deleteMcpServer).toHaveBeenCalledWith('one')
  })

  it('surfaces persistence failures without changing the form contract', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('disk full'))
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Files' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not save/i))
    )
  })

  it('probes each server on mount and shows the connected status dot', async () => {
    vi.mocked(probeMcpServer).mockResolvedValue()
    useAcpStore.setState({
      mcpServers: [{ id: 's1', type: 'stdio', name: 'Files', command: 'node', enabled: true }],
      mcpProbeStatus: { s1: 'connected' },
      mcpTools: { s1: [{ name: 'read_file' }] }
    })
    render(<McpServersSettings />)
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalledWith('s1'))
    expect(screen.getByTitle('Connected (Termul can reach this server)')).toBeInTheDocument()
  })

  it('shows the disconnected dot when the probe fails', () => {
    useAcpStore.setState({
      mcpServers: [
        { id: 's2', type: 'http', name: 'Remote', url: 'https://x.test/m', enabled: true }
      ],
      mcpProbeStatus: { s2: 'disconnected' }
    })
    render(<McpServersSettings />)
    expect(
      screen.getByTitle('Disconnected (Termul could not reach this server)')
    ).toBeInTheDocument()
  })

  it('shows the backend probe error inline for a disconnected server', () => {
    useAcpStore.setState({
      mcpServers: [
        { id: 's5', type: 'http', name: 'Remote', url: 'https://x.test/m', enabled: true }
      ],
      mcpProbeStatus: { s5: 'disconnected' },
      mcpProbeError: { s5: 'initialize failed: connection refused' }
    })
    render(<McpServersSettings />)
    // The error detail lives inside the collapsed tools disclosure; expand via
    // the disconnected-specific trigger, then assert the redacted reason.
    fireEvent.click(screen.getByText(/probe failed — retry/i))
    expect(
      screen.getByText(/probe failed — check the server config or network/i)
    ).toBeInTheDocument()
    expect(screen.getByText('initialize failed: connection refused')).toBeInTheDocument()
  })

  it('imports a Claude Desktop config and saves each entry with a fresh id', async () => {
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.click(screen.getByRole('tab', { name: /import json/i }))
    fireEvent.change(screen.getByLabelText('MCP JSON'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            dokploy: {
              command: 'npx',
              args: ['-y', '@dokploy/mcp'],
              env: { DOKPLOY_URL: 'https://dokploy.test' }
            }
          }
        })
      }
    })
    fireEvent.click(screen.getByRole('button', { name: /parse & save/i }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stdio',
        name: 'dokploy',
        command: 'npx',
        args: ['-y', '@dokploy/mcp'],
        env: [{ name: 'DOKPLOY_URL', value: 'https://dokploy.test' }],
        enabled: true
      })
    )
    // The saved id is a freshly minted one — never a registry id from the JSON.
    expect(saveMcpServer.mock.calls[0]?.[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/imported 1 mcp server/i))
    )
  })

  it('keeps invalid JSON inline and does not save anything', async () => {
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.click(screen.getByRole('tab', { name: /import json/i }))
    fireEvent.change(screen.getByLabelText('MCP JSON'), {
      target: { value: '{ this is not json' }
    })
    fireEvent.click(screen.getByRole('button', { name: /parse & save/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid json/i))
    expect(saveMcpServer).not.toHaveBeenCalled()
  })

  it('imports the valid entries while surfacing per-server errors inline', async () => {
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.click(screen.getByRole('tab', { name: /import json/i }))
    fireEvent.change(screen.getByLabelText('MCP JSON'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            good: { command: 'node', args: ['server.js'] },
            bad: { command: '   ' }
          }
        })
      }
    })
    fireEvent.click(screen.getByRole('button', { name: /parse & save/i }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'good', command: 'node', args: ['server.js'] })
    )
    // The rejected entry's reason stays visible so the user can fix and re-paste.
    expect(screen.getByRole('alert')).toHaveTextContent(/command is required for stdio/i)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('renders the tool list (read-only) inside the collapsible on expand', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's3', type: 'stdio', name: 'Probe', command: 'node', enabled: true }],
      mcpTools: { s3: [{ name: 'search', description: 'search files' }] },
      mcpToolsLoaded: { s3: true }
    })
    render(<McpServersSettings />)
    // Tools are pre-seeded → the trigger shows the count ("1 tool"), not "Show tools".
    fireEvent.click(screen.getByText(/1 tool/i))
    expect(screen.getByText('search')).toBeInTheDocument()
    // Per-tool toggle UI must NOT be present (deferred — read-only).
    expect(screen.queryByRole('switch', { name: /search/i })).not.toBeInTheDocument()
  })

  it('fires the Test button to re-probe a server', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's4', type: 'stdio', name: 'Probe', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    vi.mocked(probeMcpServer).mockClear()
    fireEvent.click(screen.getByRole('button', { name: /test probe connection/i }))
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalledWith('s4'))
  })
})
