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
