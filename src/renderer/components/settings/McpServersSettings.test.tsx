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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

function openAddDialog(): void {
  fireEvent.click(screen.getByRole('button', { name: /add server/i }))
}

function typeJson(value: string): void {
  fireEvent.change(screen.getByLabelText('MCP JSON'), { target: { value } })
}

/** Parse the current JSON editor content (edit dialog pre-fill assertions). */
function editorJson(): Record<string, unknown> {
  return JSON.parse((screen.getByLabelText('MCP JSON') as HTMLTextAreaElement).value)
}

describe('McpServersSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedStore()
  })

  it('adds a bare server object through the JSON editor with a fresh id', async () => {
    render(<McpServersSettings />)
    openAddDialog()
    expect(screen.getByText('Add MCP servers')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save' })
    // Empty JSON text keeps Save disabled — no accidental junk entries.
    expect(save).toBeDisabled()
    typeJson(JSON.stringify({ command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, name: 'Files' }))
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stdio',
        name: 'Files',
        command: 'npx',
        args: ['-y', 'x'],
        env: [{ name: 'K', value: 'v' }],
        enabled: true
      })
    )
    expect(saveMcpServer.mock.calls[0]?.[0].id).toMatch(UUID_RE)
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/imported 1 mcp server/i))
    )
    // The dialog closes after a fully successful save.
    expect(screen.queryByLabelText('MCP JSON')).not.toBeInTheDocument()
  })

  it('adds both servers from a Claude Desktop wrapper, each with a fresh id', async () => {
    render(<McpServersSettings />)
    openAddDialog()
    typeJson(
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'node', args: ['a.js'] },
          beta: { type: 'http', url: 'https://beta.test/mcp' }
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(2))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stdio', name: 'alpha', command: 'node', enabled: true })
    )
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http',
        name: 'beta',
        url: 'https://beta.test/mcp',
        enabled: true
      })
    )
    const firstId = saveMcpServer.mock.calls[0]?.[0].id
    const secondId = saveMcpServer.mock.calls[1]?.[0].id
    expect(firstId).toMatch(UUID_RE)
    expect(secondId).toMatch(UUID_RE)
    expect(firstId).not.toBe(secondId)
  })

  it('shows invalid JSON inline and saves nothing', async () => {
    render(<McpServersSettings />)
    openAddDialog()
    typeJson('{ this is not json')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid json/i))
    expect(saveMcpServer).not.toHaveBeenCalled()
  })

  it('saves valid entries and keeps per-server errors inline for the bad ones', async () => {
    render(<McpServersSettings />)
    openAddDialog()
    typeJson(
      JSON.stringify({
        mcpServers: {
          good: { command: 'node', args: ['server.js'] },
          bad: { command: '   ' }
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'good', command: 'node', args: ['server.js'] })
    )
    // The rejected entry's reason stays visible so the user can fix and re-save.
    expect(screen.getByRole('alert')).toHaveTextContent(/command is required for stdio/i)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('reports an empty wrapper without saving', async () => {
    render(<McpServersSettings />)
    openAddDialog()
    typeJson(JSON.stringify({ mcpServers: {} }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/no mcp servers found in the json/i)
    )
    expect(saveMcpServer).not.toHaveBeenCalled()
  })

  it('pre-fills the edit dialog and updates the same registry entry', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 's1',
          type: 'stdio',
          name: 'Files',
          command: 'node',
          args: ['server.js'],
          env: [{ name: 'TOKEN', value: '$TOKEN' }],
          enabled: true
        }
      ]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit files/i }))
    expect(screen.getByText('Edit MCP server')).toBeInTheDocument()
    // Pre-populated JSON: explicit type, env as an object map, enabled included.
    expect(editorJson()).toMatchObject({
      type: 'stdio',
      name: 'Files',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: '$TOKEN' },
      enabled: true
    })
    // Change the command and smuggle an unknown field in — it must be dropped.
    const edited = editorJson()
    edited.command = 'bun'
    edited.alwaysAllow = true
    typeJson(JSON.stringify(edited, null, 2))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 's1',
          type: 'stdio',
          name: 'Files',
          command: 'bun',
          args: ['server.js'],
          env: [{ name: 'TOKEN', value: '$TOKEN' }],
          enabled: true
        })
      )
    )
    expect(saveMcpServer).toHaveBeenCalledWith(expect.not.objectContaining({ alwaysAllow: true }))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/mcp server updated/i))
    )
  })

  it('pre-fills HTTP servers with header pairs and updates the url in place', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'http-1',
          type: 'http',
          name: 'Remote',
          url: 'https://old.test/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer $TOKEN' }],
          enabled: true
        }
      ]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit remote/i }))
    expect(editorJson()).toMatchObject({
      type: 'http',
      name: 'Remote',
      url: 'https://old.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer $TOKEN' }],
      enabled: true
    })
    const edited = editorJson()
    edited.url = 'https://new.test/mcp'
    typeJson(JSON.stringify(edited))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'http-1',
          type: 'http',
          url: 'https://new.test/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer $TOKEN' }]
        })
      )
    )
  })

  it('persists enabled: false from the edit JSON', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's2', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit files/i }))
    const edited = editorJson()
    edited.enabled = false
    typeJson(JSON.stringify(edited))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's2', enabled: false })
      )
    )
  })

  it('keeps the existing enabled state when the edit JSON omits it', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's3', type: 'stdio', name: 'Files', command: 'node', enabled: false }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit files/i }))
    const edited = editorJson()
    expect(edited.enabled).toBe(false)
    delete edited.enabled
    typeJson(JSON.stringify(edited))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's3', enabled: false })
      )
    )
  })

  it('rejects the mcpServers wrapper while editing a single server', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's4', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit files/i }))
    typeJson(JSON.stringify({ mcpServers: { files: { command: 'node' } } }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/single server object/i)
    )
    expect(saveMcpServer).not.toHaveBeenCalled()
  })

  it('shows validation errors inline when the edit JSON is invalid', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's6', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit files/i }))
    typeJson(JSON.stringify({ type: 'stdio', name: 'Files', command: '' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/command is required for stdio/i)
    )
    expect(saveMcpServer).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the rollback toast when saving fails', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('disk full'))
    render(<McpServersSettings />)
    openAddDialog()
    typeJson(JSON.stringify({ name: 'Files', command: 'node' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not save/i))
    )
    // The dialog stays open so the JSON is not lost after a rollback.
    expect(screen.getByLabelText('MCP JSON')).toBeInTheDocument()
  })

  it('keeps the edit dialog open when the update fails', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('disk full'))
    useAcpStore.setState({
      mcpServers: [{ id: 's7', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit files/i }))
    const edited = editorJson()
    edited.command = 'bun'
    typeJson(JSON.stringify(edited))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not save/i))
    )
    expect(screen.getByLabelText('MCP JSON')).toBeInTheDocument()
    expect(screen.getByText('Edit MCP server')).toBeInTheDocument()
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

  it('probes enabled servers on mount and shows the connected status dot', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's1', type: 'stdio', name: 'Files', command: 'node', enabled: true }],
      mcpProbeStatus: { s1: 'connected' },
      mcpTools: { s1: [{ name: 'read_file' }] }
    })
    render(<McpServersSettings />)
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalledWith('s1'))
    expect(screen.getByTitle('Connected (Termul can reach this server)')).toBeInTheDocument()
  })

  it('shows the disconnected dot and the probe error behind the disclosure', () => {
    useAcpStore.setState({
      mcpServers: [
        { id: 's5', type: 'http', name: 'Remote', url: 'https://x.test/m', enabled: true }
      ],
      mcpProbeStatus: { s5: 'disconnected' },
      mcpProbeError: { s5: 'initialize failed: connection refused' }
    })
    render(<McpServersSettings />)
    expect(
      screen.getByTitle('Disconnected (Termul could not reach this server)')
    ).toBeInTheDocument()
    // The error detail lives behind the tools disclosure; expand via the
    // disconnected-specific trigger, then assert the redacted reason.
    fireEvent.click(screen.getByText(/probe failed — retry/i))
    expect(
      screen.getByText(/probe failed — check the server config or network/i)
    ).toBeInTheDocument()
    expect(screen.getByText('initialize failed: connection refused')).toBeInTheDocument()
  })

  it('renders the tool list (read-only) inside the collapsible on expand', () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's3', type: 'stdio', name: 'Probe', command: 'node', enabled: true }],
      mcpTools: { s3: [{ name: 'search', description: 'search files' }] },
      mcpToolsLoaded: { s3: true }
    })
    render(<McpServersSettings />)
    // Tools are pre-seeded -> the trigger shows the count ("1 tool").
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

  it('renders one compact row per server — detail inline, no form fields', () => {
    useAcpStore.setState({
      mcpServers: [
        { id: 'c1', type: 'stdio', name: 'Files', command: 'node server.js', enabled: true },
        { id: 'c2', type: 'http', name: 'Remote', url: 'https://remote.test/mcp', enabled: true }
      ]
    })
    render(<McpServersSettings />)
    // Command/URL detail is visible straight from the collapsed row.
    expect(screen.getByText('node server.js')).toBeInTheDocument()
    expect(screen.getByText('https://remote.test/mcp')).toBeInTheDocument()
    // No remnants of the old form inputs or the Form/Import tab bar.
    expect(screen.queryByLabelText(/arguments \(one per line\)/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/environment \(name=value/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /import json/i })).not.toBeInTheDocument()
    // All row controls stay accessible from the single line.
    expect(screen.getByRole('button', { name: /test files connection/i })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /disable files/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /edit files/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete files/i })).toBeInTheDocument()
    // Preserved surfaces: storage warning + experimental MCP-over-ACP card.
    expect(screen.getByText('$VARIABLE')).toBeInTheDocument()
    expect(screen.getByText(/experimental mcp-over-acp/i)).toBeInTheDocument()
  })
})
