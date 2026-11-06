import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_UNSAFE_URL, McpOAuthError } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { McpServersSettings } from './McpServersSettings'

const { toastError, toastSuccess, toastFn } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastFn: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, { error: toastError, success: toastSuccess })
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

const saveMcpServer = vi.fn(async () => {})
const importMcpServers = vi.fn(async (_servers: unknown[]) => {})
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
    importMcpServers,
    setMcpServerEnabled,
    deleteMcpServer,
    probeMcpServer,
    loadMcpTools
  })
}

function openAddForm(): void {
  fireEvent.click(screen.getByRole('button', { name: /add server/i }))
}

function openAddDialog(): void {
  openAddForm()
  fireEvent.click(screen.getByRole('button', { name: 'Import JSON instead' }))
}

function openEditJson(server: string): void {
  chooseRowAction(server, 'Edit')
  fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }))
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function choose(combobox: string, option: string): void {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

function typeJson(value: string): void {
  fireEvent.change(screen.getByLabelText('MCP JSON'), { target: { value } })
}

/** Open a server's row menu (Radix opens on pointerdown) and choose an item. */
function chooseRowAction(server: string, item: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${server}` }), {
    button: 0,
    ctrlKey: false
  })
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
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

  it('does not claim to retain the experimental acp capability (issue #362)', () => {
    // The Rust schema is built without `unstable_mcp_over_acp`, so an agent's
    // `mcpCapabilities.acp` is dropped on parse (pinned in the Rust events
    // tests). The notice must say Termul does not read it.
    render(<McpServersSettings />)
    const notice = screen.getByText(/MCP-over-ACP/).closest('p')
    expect(notice).toHaveTextContent('does not read it')
    expect(notice).not.toHaveTextContent('retains')
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
    await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
    // Add persists through the atomic batch action (one store write).
    expect(importMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'stdio',
        name: 'Files',
        command: 'npx',
        args: ['-y', 'x'],
        env: [{ name: 'K', value: 'v' }],
        enabled: true
      })
    ])
    expect(importMcpServers.mock.calls[0]?.[0]?.[0]?.id).toMatch(UUID_RE)
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/added 1 mcp server/i))
    )
    // The dialog closes after a fully successful save.
    expect(screen.queryByLabelText('MCP JSON')).not.toBeInTheDocument()
  })

  it('adds both servers from a Claude Desktop wrapper in one atomic batch', async () => {
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
    await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
    // One call with the whole batch — not one save per entry.
    const batch = vi.mocked(importMcpServers).mock.calls[0]?.[0] ?? []
    expect(batch).toHaveLength(2)
    expect(batch[0]).toEqual(
      expect.objectContaining({ type: 'stdio', name: 'alpha', command: 'node', enabled: true })
    )
    expect(batch[1]).toEqual(
      expect.objectContaining({
        type: 'http',
        name: 'beta',
        url: 'https://beta.test/mcp',
        enabled: true
      })
    )
    const firstId = batch[0]?.id as string | undefined
    const secondId = batch[1]?.id as string | undefined
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
    expect(importMcpServers).not.toHaveBeenCalled()
  })

  it('rejects the whole batch while any entry is invalid, then saves all once corrected', async () => {
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
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/command is required for stdio/i)
    )
    // All-or-nothing: nothing persists while any entry is invalid, so the
    // corrected re-save cannot duplicate an earlier partial save.
    expect(importMcpServers).not.toHaveBeenCalled()
    typeJson(
      JSON.stringify({
        mcpServers: {
          good: { command: 'node', args: ['server.js'] },
          bad: { command: 'node', args: ['bad.js'] }
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
    expect(importMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'good', command: 'node', args: ['server.js'] }),
      expect.objectContaining({ name: 'bad', command: 'node', args: ['bad.js'] })
    ])
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/added 2 mcp servers/i))
    )
  })

  it('reports an empty wrapper without saving', async () => {
    render(<McpServersSettings />)
    openAddDialog()
    typeJson(JSON.stringify({ mcpServers: {} }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/no mcp servers found in the json/i)
    )
    expect(importMcpServers).not.toHaveBeenCalled()
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
    openEditJson('Files')
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
    openEditJson('Remote')
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

  it('keeps catalog provenance only while an edit leaves the launch unchanged', async () => {
    const catalog = {
      source: 'mcp-registry' as const,
      name: 'io.example/files',
      version: '1.0.0',
      kind: 'package' as const,
      index: 0,
      repositoryId: null,
      launchDigest: 'digest-1'
    }
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'cat',
          type: 'stdio',
          name: 'Files',
          command: 'npx',
          args: ['-y', '@example/files'],
          env: [{ name: 'TOKEN', value: 'old' }],
          enabled: true,
          catalog
        }
      ]
    })
    render(<McpServersSettings />)

    openEditJson('Files')
    const renamed = editorJson()
    renamed.name = 'My files'
    renamed.env = { TOKEN: 'new' }
    typeJson(JSON.stringify(renamed))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'My files', env: [{ name: 'TOKEN', value: 'new' }], catalog })
    )

    openEditJson('Files')
    const relaunched = editorJson()
    relaunched.args = ['-y', '@example/files', '--root', '/']
    typeJson(JSON.stringify(relaunched))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(2))
    expect(saveMcpServer).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ catalog: expect.anything() })
    )
    expect(saveMcpServer).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ['-y', '@example/files', '--root', '/'] })
    )
  })

  it('persists enabled: false from the edit JSON', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's2', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    openEditJson('Files')
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
    openEditJson('Files')
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
    openEditJson('Files')
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
    openEditJson('Files')
    typeJson(JSON.stringify({ type: 'stdio', name: 'Files', command: '' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/command is required for stdio/i)
    )
    expect(saveMcpServer).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the rollback toast when saving fails', async () => {
    importMcpServers.mockRejectedValueOnce(new Error('disk full'))
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

  it('blocks dialog dismissal while a save is pending', async () => {
    // A save that never settles until the test releases it.
    let releaseSave: (() => void) | undefined
    importMcpServers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        })
    )
    render(<McpServersSettings />)
    openAddDialog()
    typeJson(JSON.stringify({ name: 'Files', command: 'node' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
    // While the save is in flight, Cancel is disabled and overlay/Escape
    // dismissal (onOpenChange) is ignored — the JSON must not be lost.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.keyDown(screen.getByLabelText('MCP JSON'), { key: 'Escape' })
    expect(screen.getByLabelText('MCP JSON')).toBeInTheDocument()
    // Once the save settles the dialog completes normally.
    releaseSave?.()
    await waitFor(() => expect(screen.queryByLabelText('MCP JSON')).not.toBeInTheDocument())
  })

  it('keeps the edit dialog open when the update fails', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('disk full'))
    useAcpStore.setState({
      mcpServers: [{ id: 's7', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    openEditJson('Files')
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
    chooseRowAction('Files', 'Delete')
    await waitFor(() => expect(setMcpServerEnabled).toHaveBeenCalledWith('one', false))
    expect(deleteMcpServer).toHaveBeenCalledWith('one')
    // Delete acts at once and offers Undo, which re-saves the same server.
    await waitFor(() => expect(toastFn).toHaveBeenCalled())
    const [message, options] = toastFn.mock.calls[0] as [
      string,
      { action: { onClick: () => void } }
    ]
    expect(message).toBe('Deleted Files')
    options.action.onClick()
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'one', name: 'Files' })
    )
  })

  it('probes enabled servers on mount and shows the Connected status word', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 's1', type: 'stdio', name: 'Files', command: 'node', enabled: true }],
      mcpProbeStatus: { s1: 'connected' },
      mcpTools: { s1: [{ name: 'read_file' }] }
    })
    render(<McpServersSettings />)
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalledWith('s1'))
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })

  it('shows Unreachable and the probe error with a fix behind the disclosure', () => {
    useAcpStore.setState({
      mcpServers: [
        { id: 's5', type: 'http', name: 'Remote', url: 'https://x.test/m', enabled: true }
      ],
      mcpProbeStatus: { s5: 'disconnected' },
      mcpProbeError: { s5: 'initialize failed: connection refused' }
    })
    render(<McpServersSettings />)
    expect(screen.getByText('Unreachable')).toBeInTheDocument()
    // The error detail lives behind the tools disclosure; expand via the
    // disconnected-specific trigger, then assert the redacted reason.
    fireEvent.click(screen.getByText(/show error/i))
    expect(screen.getByText(/could not reach this server/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByText('initialize failed: connection refused')).toBeInTheDocument()
  })

  it('names a refused sign-in link instead of pointing at the browser', async () => {
    const { connectMcpOAuth: realConnect, checkMcpOAuthStatus: realCheck } = useAcpStore.getState()
    const connectMcpOAuth = vi.fn(async () => {
      throw new McpOAuthError(
        'refused an unsafe link: only https links are allowed',
        MCP_UNSAFE_URL
      )
    })
    useAcpStore.setState({
      mcpServers: [
        { id: 's6', type: 'http', name: 'Remote', url: 'https://x.test/m', enabled: true }
      ],
      mcpProbeStatus: { s6: 'authRequired' },
      connectMcpOAuth,
      checkMcpOAuthStatus: vi.fn(async () => {})
    })
    try {
      render(<McpServersSettings />)
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "This server's sign-in link isn't a secure https link, so Termul didn't open it."
        )
      )

      connectMcpOAuth.mockRejectedValueOnce(
        new McpOAuthError('Discovery failed', 'OAUTH_START_FAILED')
      )
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      await waitFor(() =>
        expect(toastError).toHaveBeenLastCalledWith(
          'OAuth flow failed. Check your browser for the authorization page.'
        )
      )
    } finally {
      useAcpStore.setState({ connectMcpOAuth: realConnect, checkMcpOAuthStatus: realCheck })
    }
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
    chooseRowAction('Probe', 'Test connection')
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
    expect(screen.getByRole('switch', { name: /disable files/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Actions for Files' })).toBeInTheDocument()
    // Preserved surfaces: storage warning + experimental MCP-over-ACP card.
    expect(screen.getByText('$VARIABLE')).toBeInTheDocument()
    expect(screen.getByText(/mcp-over-acp/i)).toBeInTheDocument()
  })

  describe('guided form', () => {
    it('adds a local server from a pasted command line and env rows', async () => {
      render(<McpServersSettings />)
      openAddForm()
      expect(screen.getByRole('heading', { name: 'Add MCP server' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('radio', { name: /on this computer/i }))
      type('Name', 'github')
      type('Command', `GITHUB_TOKEN=$GH_TOKEN npx -y "@modelcontextprotocol/server-github"`)
      type('Environment variable 1 name', 'DEBUG')
      type('Environment variable 1 value', 'mcp:*')
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
      expect(importMcpServers).toHaveBeenCalledWith([
        {
          type: 'stdio',
          name: 'github',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: [
            { name: 'DEBUG', value: 'mcp:*' },
            { name: 'GITHUB_TOKEN', value: '$GH_TOKEN' }
          ],
          id: expect.stringMatching(UUID_RE),
          enabled: true
        }
      ])
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Added 1 MCP server'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('moves a leading NAME=value into the env rows when the command loses focus', () => {
      render(<McpServersSettings />)
      openAddForm()
      fireEvent.click(screen.getByRole('radio', { name: /on this computer/i }))
      type('Command', 'API_KEY=abc uvx mcp-server-git')
      fireEvent.blur(screen.getByLabelText('Command'))
      expect(screen.getByLabelText('Command')).toHaveValue('uvx mcp-server-git')
      expect(screen.getByLabelText('Environment variable 1 name')).toHaveValue('API_KEY')
      expect(screen.getByLabelText('Environment variable 1 value')).toHaveValue('abc')
      expect(screen.getByLabelText('Environment variable 1 value')).toHaveAttribute(
        'type',
        'password'
      )
    })

    it('starts the command from a Common chip', () => {
      render(<McpServersSettings />)
      openAddForm()
      fireEvent.click(screen.getByRole('radio', { name: /on this computer/i }))
      type('Command', '@dokploy/mcp')
      fireEvent.click(screen.getByRole('button', { name: 'npx -y …' }))
      expect(screen.getByLabelText('Command')).toHaveValue('npx -y @dokploy/mcp')
    })

    it('adds a remote server with an API key header', async () => {
      render(<McpServersSettings />)
      openAddForm()
      type('Name', 'linear')
      type('Server URL', 'https://mcp.linear.app/mcp')
      choose('Sign-in', 'API key or token')
      expect(screen.getByLabelText('Header 1 name')).toHaveValue('Authorization')
      expect(screen.getByLabelText('Header 1 value')).toHaveAttribute('placeholder', 'Bearer …')
      type('Header 1 value', 'Bearer $LINEAR_KEY')
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
      expect(importMcpServers).toHaveBeenCalledWith([
        {
          type: 'http',
          name: 'linear',
          url: 'https://mcp.linear.app/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer $LINEAR_KEY' }],
          id: expect.stringMatching(UUID_RE),
          enabled: true
        }
      ])
    })

    it('picks SSE from the URL until the connection type is chosen by hand', async () => {
      render(<McpServersSettings />)
      openAddForm()
      type('Name', 'asana')
      type('Server URL', 'https://mcp.asana.com/sse')
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
      expect(screen.getByRole('combobox', { name: 'Connection type' })).toHaveTextContent(
        'SSE (older servers)'
      )
      choose('Connection type', 'Streamable HTTP (recommended)')
      type('Server URL', 'https://mcp.asana.com/v2/sse')
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
      expect(importMcpServers).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'http', url: 'https://mcp.asana.com/v2/sse' })
      ])
    })

    it('blocks Save on a header without a value and logs only the field name', async () => {
      render(<McpServersSettings />)
      openAddForm()
      type('Name', 'linear')
      type('Server URL', 'https://mcp.linear.app/mcp')
      choose('Sign-in', 'API key or token')
      expect(screen.getByText('Needs a value.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      await waitFor(() =>
        expect(logFrontendError).toHaveBeenCalledWith({
          level: 'warn',
          source: 'settings.McpServersSettings',
          message: 'MCP server form rejected: headers'
        })
      )
      expect(importMcpServers).not.toHaveBeenCalled()
      type('Header 1 value', 'Bearer secret-value')
      expect(screen.queryByText('Needs a value.')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      await waitFor(() => expect(importMcpServers).toHaveBeenCalledTimes(1))
      expect(JSON.stringify(vi.mocked(logFrontendError).mock.calls)).not.toContain('secret-value')
    })

    it('shows required-field errors only after Save', async () => {
      render(<McpServersSettings />)
      openAddForm()
      expect(screen.queryByText('Give the server a name.')).not.toBeInTheDocument()
      type('Server URL', 'mcp.linear.app')
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      expect(await screen.findByText('Give the server a name.')).toBeInTheDocument()
      expect(
        screen.getByText('Enter a full URL, like https://mcp.example.com/mcp.')
      ).toBeInTheDocument()
      expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
      expect(importMcpServers).not.toHaveBeenCalled()
    })

    it("keeps each card's input when switching between them, by mouse or arrow keys", () => {
      render(<McpServersSettings />)
      openAddForm()
      const remote = screen.getByRole('radio', { name: /on the internet/i })
      expect(remote).toHaveAttribute('aria-checked', 'true')
      type('Server URL', 'https://mcp.linear.app/mcp')
      fireEvent.keyDown(remote, { key: 'ArrowRight' })
      const local = screen.getByRole('radio', { name: /on this computer/i })
      expect(local).toHaveAttribute('aria-checked', 'true')
      expect(local).toHaveFocus()
      type('Command', 'uvx mcp-server-git')
      fireEvent.click(remote)
      expect(screen.getByLabelText('Server URL')).toHaveValue('https://mcp.linear.app/mcp')
      fireEvent.click(local)
      expect(screen.getByLabelText('Command')).toHaveValue('uvx mcp-server-git')
    })

    it('carries a single pasted server from JSON back into the form', () => {
      render(<McpServersSettings />)
      openAddDialog()
      typeJson(JSON.stringify({ name: 'docs', type: 'sse', url: 'https://docs.test/events' }))
      fireEvent.click(screen.getByRole('button', { name: 'Use the form' }))
      expect(screen.getByLabelText('Name')).toHaveValue('docs')
      expect(screen.getByLabelText('Server URL')).toHaveValue('https://docs.test/events')
      expect(screen.getByRole('combobox', { name: 'Connection type' })).toHaveTextContent(
        'SSE (older servers)'
      )
    })

    it('edits a server in the form, keeping its id, enabled state and catalog provenance', async () => {
      const catalog = {
        source: 'mcp-registry' as const,
        name: 'io.example/files',
        version: '1.0.0',
        kind: 'package' as const,
        index: 0,
        repositoryId: null,
        launchDigest: 'digest-1'
      }
      useAcpStore.setState({
        mcpServers: [
          {
            id: 'cat',
            type: 'stdio',
            name: 'Files',
            command: 'npx',
            args: ['-y', '@example/files', '/srv/my files'],
            env: [{ name: 'TOKEN', value: 'old' }],
            enabled: false,
            catalog
          }
        ]
      })
      render(<McpServersSettings />)
      chooseRowAction('Files', 'Edit')
      expect(screen.getByRole('heading', { name: 'Edit MCP server' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /on this computer/i })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      expect(screen.getByLabelText('Command')).toHaveValue("npx -y @example/files '/srv/my files'")
      type('Name', 'My files')
      type('Environment variable 1 value', 'new')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
      expect(saveMcpServer).toHaveBeenCalledWith({
        type: 'stdio',
        name: 'My files',
        command: 'npx',
        args: ['-y', '@example/files', '/srv/my files'],
        env: [{ name: 'TOKEN', value: 'new' }],
        id: 'cat',
        enabled: false,
        catalog
      })
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('MCP server updated'))

      chooseRowAction('Files', 'Edit')
      type('Command', 'npx -y @example/files --root /')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(2))
      expect(saveMcpServer).toHaveBeenLastCalledWith({
        type: 'stdio',
        name: 'Files',
        command: 'npx',
        args: ['-y', '@example/files', '--root', '/'],
        env: [{ name: 'TOKEN', value: 'old' }],
        id: 'cat',
        enabled: false
      })
    })

    it('opens Edit as JSON with the form changes applied', () => {
      useAcpStore.setState({
        mcpServers: [
          { id: 'r1', type: 'http', name: 'Remote', url: 'https://old.test/mcp', enabled: true }
        ]
      })
      render(<McpServersSettings />)
      chooseRowAction('Remote', 'Edit')
      type('Server URL', 'https://new.test/sse')
      fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }))
      expect(editorJson()).toEqual({
        type: 'sse',
        name: 'Remote',
        url: 'https://new.test/sse',
        enabled: true
      })
    })

    it('keeps the form open with the rollback toast and a log when the save fails', async () => {
      importMcpServers.mockRejectedValueOnce(new Error('disk full'))
      render(<McpServersSettings />)
      openAddForm()
      type('Name', 'linear')
      type('Server URL', 'https://mcp.linear.app/mcp')
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'Could not save the MCP servers. Your previous settings were restored.'
        )
      )
      expect(logFrontendError).toHaveBeenCalledWith({
        level: 'error',
        source: 'settings.McpServersSettings',
        message: 'MCP server add failed to save; the store rolled back'
      })
      expect(screen.getByLabelText('Server URL')).toHaveValue('https://mcp.linear.app/mcp')
    })
  })
})
