import type {
  AgentTool,
  AutomationNode,
  AutomationOp,
  Graph,
  KnownAgent,
  NamedTemplate,
  NodeId,
  NodeSpec
} from '@shared/types/automation.types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpToolInfo } from '@/lib/acp-api'
import { detailWith, fixtureAutomation } from '@/lib/test-utils/automation-fixtures'
import { useAcpStore } from '@/stores/acp-store'

const api = vi.hoisted(() => ({
  applyAutomationOps: vi.fn(),
  approveAutomation: vi.fn(),
  getAutomation: vi.fn(),
  listAutomationAgents: vi.fn(),
  onAutomationChanged: vi.fn((_listener: unknown) => () => {}),
  previewAutomationOps: vi.fn(),
  previewSchedule: vi.fn(),
  setAutomationLayout: vi.fn()
}))
vi.mock('@/lib/automation-api', () => api)
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
const catalogs = vi.hoisted(() => ({ readModelCatalog: vi.fn() }))
vi.mock('@/stores/acp-store/model-catalog', () => catalogs)

import { AutomationEditor } from '../AutomationEditor'

const id = (value: string) => value as NodeId
const ok = <T,>(data: T) => ({ success: true as const, data })

/** The shared fixture is the host's `sample_automation`, which `graph_tests.rs` validates clean. */
const sample = fixtureAutomation.graph
const extractSpec = sample.nodes.find((n) => n.id === 'extract')?.spec as Extract<
  NodeSpec,
  { kind: 'agent' }
>

const mcpSpec: NodeSpec = {
  kind: 'mcp_tool',
  server_id: 'gh',
  tool: 'add_labels',
  arguments: [],
  timeout_ms: 60_000
}

function graphWith(extract: Partial<typeof extractSpec>): Graph {
  const nodes: AutomationNode[] = sample.nodes.map((n) =>
    n.id === 'extract' ? { ...n, spec: { ...extractSpec, ...extract } } : n
  )
  return {
    nodes: [...nodes, { id: id('label_it'), label: 'Post label', spec: mcpSpec }],
    edges: [...sample.edges, { from: id('shape'), port: 'error', to: id('label_it') }]
  }
}

const detailOf = (graph: Graph) =>
  detailWith({ revision: 7, approved_revision: 7, trigger: { kind: 'manual' }, graph, layout: {} })

const AGENTS: KnownAgent[] = [
  { agent_id: 'claude', name: 'Claude Code' },
  { agent_id: 'codex', name: 'Codex' }
]

function open(graph: Graph = graphWith({}), phone = false) {
  const detail = detailOf(graph)
  api.previewAutomationOps.mockResolvedValue(ok(detail))
  render(<AutomationEditor detail={detail} phone={phone} onClose={vi.fn()} onChanged={vi.fn()} />)
  return detail
}

function inspect(nodeId: string, text: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
  if (!card) throw new Error(`no card for ${nodeId}`)
  fireEvent.click(within(card).getAllByText(text)[0])
  return screen.getByRole('complementary', { name: `Inspect ${text}` })
}

function enter(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } })
  fireEvent.blur(field)
}

function choose(panel: HTMLElement, label: string, option: string): void {
  fireEvent.click(within(panel).getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

async function expectPending(ops: AutomationOp[]): Promise<void> {
  await waitFor(() =>
    expect(api.previewAutomationOps).toHaveBeenLastCalledWith(fixtureAutomation.id, 7, ops)
  )
}

const updated = (nodeId: string, spec: NodeSpec): AutomationOp => ({
  op: 'update_node',
  id: id(nodeId),
  spec
})

const status = () => screen.getByTestId('draft-status').textContent
const undo = () =>
  fireEvent.keyDown(screen.getByTestId('automation-editor'), { key: 'z', ctrlKey: true })

const UNTRUSTED_FLOW = /This agent reads content fetched from the web or returned by an MCP tool/

function seedMcp(tools: McpToolInfo[] | null) {
  useAcpStore.setState({
    mcpServers: [
      { id: 'gh', name: 'github', type: 'http', url: 'https://mcp.example.com' },
      { id: 'off', name: 'disabled one', type: 'http', url: 'https://x.example', enabled: false },
      { id: 'fs', name: 'files', command: 'mcp-files' }
    ],
    mcpServersLoaded: true,
    mcpTools: tools ? { gh: tools } : {},
    mcpToolsLoaded: tools ? { gh: true } : {},
    mcpProbeStatus: tools ? { gh: 'connected' } : {},
    mcpProbeError: {},
    loadMcpTools: vi.fn(async () => {})
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  document.elementFromPoint = () => null
  api.listAutomationAgents.mockResolvedValue(ok(AGENTS))
  api.previewSchedule.mockResolvedValue(ok({ next_runs: [], error: null }))
  catalogs.readModelCatalog.mockImplementation(async (agentId: string) =>
    agentId === 'claude'
      ? {
          models: {
            currentModelId: 'sonnet',
            availableModels: [
              { modelId: 'sonnet', name: 'Sonnet' },
              { modelId: 'opus', name: 'Opus' }
            ]
          },
          modelOption: null,
          updatedAt: 1
        }
      : null
  )
  useAcpStore.setState({ agentOptionsCache: {} })
  seedMcp([
    { name: 'add_labels', description: 'Add labels to an issue' },
    { name: 'create_issue', description: 'Open an issue' }
  ])
})

describe('AgentForm', () => {
  it('lists the agents after loading; a pick is one update_node that resets the model, and undo restores it', async () => {
    let answer: (value: ReturnType<typeof ok<KnownAgent[]>>) => void = () => {}
    api.listAutomationAgents.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    open()
    const panel = inspect('extract', 'Extract')
    const agent = within(panel).getByRole('combobox', { name: 'Agent' })
    expect(agent).toBeDisabled()

    await act(async () => answer(ok(AGENTS)))
    expect(agent).toBeEnabled()
    expect(agent).toHaveTextContent('Claude Code')
    choose(panel, 'Agent', 'Codex')

    await expectPending([updated('extract', { ...extractSpec, agent_id: 'codex', model: null })])
    expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('Default')
    undo()
    expect(status()).toBe('No unsaved changes')
    expect(within(panel).getByRole('combobox', { name: 'Agent' })).toHaveTextContent('Claude Code')
  })

  it('shows a failed agent list with Retry, which lists again', async () => {
    api.listAutomationAgents.mockResolvedValueOnce({ success: false, error: 'host offline' })
    open()
    const panel = inspect('extract', 'Extract')
    expect(await within(panel).findByText('Could not list the agents: host offline')).toBeVisible()

    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(within(panel).queryByText('Could not list the agents: host offline')).toBeNull()
    )
    expect(api.listAutomationAgents).toHaveBeenCalledTimes(2)
  })

  it('with no known agents, says how to add one and keeps the step agent as not known', async () => {
    api.listAutomationAgents.mockResolvedValue(ok([]))
    open()
    const panel = inspect('extract', 'Extract')
    expect(
      await within(panel).findByText('No agents yet. Start one once in a chat and it shows here.')
    ).toBeVisible()
    expect(within(panel).getByRole('combobox', { name: 'Agent' })).toHaveTextContent('claude')
  })

  it('offers Default plus the models the agent reported; picks commit the id or null', async () => {
    open()
    const panel = inspect('extract', 'Extract')
    const model = within(panel).getByRole('combobox', { name: 'Model' })
    await waitFor(() => expect(model).toHaveTextContent('Sonnet'))
    expect(catalogs.readModelCatalog).toHaveBeenCalledWith('claude')

    choose(panel, 'Model', 'Opus')
    choose(panel, 'Model', 'Default')
    await expectPending([
      updated('extract', { ...extractSpec, model: 'opus' }),
      updated('extract', { ...extractSpec, model: null })
    ])
  })

  it('commits the prompt on blur, with {{ offering the steps before it', async () => {
    open()
    const panel = inspect('extract', 'Extract')
    const prompt = within(panel).getByLabelText('Prompt')
    fireEvent.change(prompt, { target: { value: 'Sort {{ ', selectionStart: 8 } })
    prompt.setSelectionRange(8, 8)
    fireEvent.select(prompt)
    expect(screen.getByRole('option', { name: /nodes\.fetch\.output/ })).toBeVisible()
    expect(screen.queryByRole('option', { name: /nodes\.check\.output/ })).toBeNull()

    enter(prompt, 'Sort {{ nodes.fetch.output.items }}')
    await expectPending([
      updated('extract', { ...extractSpec, prompt: 'Sort {{ nodes.fetch.output.items }}' })
    ])
  })

  it('timeout commits in milliseconds and max attempts as a number; out of range shows inline', async () => {
    open()
    const panel = inspect('extract', 'Extract')
    const timeout = within(panel).getByLabelText('Timeout')
    expect(timeout).toHaveValue('120')
    enter(timeout, '1000')
    expect(within(panel).getByText('Between 1 and 900 seconds')).toBeVisible()
    enter(within(panel).getByLabelText('Max attempts'), '4')
    expect(within(panel).getByText('Between 1 and 3')).toBeVisible()
    enter(within(panel).getByLabelText('Max attempts'), 'two')
    expect(within(panel).getByText('Enter a whole number')).toBeVisible()

    await expectPending([
      updated('extract', { ...extractSpec, timeout_ms: 1_000_000 }),
      updated('extract', { ...extractSpec, timeout_ms: 1_000_000, max_attempts: 4 })
    ])

    enter(timeout, '1e300')
    expect(within(panel).getByText('That is too long')).toBeVisible()
    expect(fireEvent.keyDown(timeout, { key: 'Escape' })).toBe(false)
    expect(timeout).toHaveValue('1000')
    expect(within(panel).queryByText('That is too long')).toBeNull()
  })

  it('output schema: adds, renames and retypes a field, and refuses JSON the host would', async () => {
    open(graphWith({ output_schema: { type: 'object' } }))
    const panel = inspect('extract', 'Extract')
    fireEvent.click(within(panel).getByRole('button', { name: /Output schema/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Add field' }))
    enter(within(panel).getByLabelText('Field field name'), 'title')
    choose(panel, 'title kind', 'integer')
    fireEvent.click(within(panel).getByRole('switch', { name: 'title required' }))

    const base = { ...extractSpec, output_schema: { type: 'object' as const } }
    await expectPending([
      updated('extract', {
        ...base,
        output_schema: {
          type: 'object',
          properties: { field: { type: 'string' } },
          required: ['field']
        }
      }),
      updated('extract', {
        ...base,
        output_schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title']
        }
      }),
      updated('extract', {
        ...base,
        output_schema: {
          type: 'object',
          properties: { title: { type: 'integer' } },
          required: ['title']
        }
      }),
      updated('extract', {
        ...base,
        output_schema: { type: 'object', properties: { title: { type: 'integer' } } }
      })
    ])

    enter(within(panel).getByLabelText('As JSON'), '{"type":"object","required":["x"]}')
    expect(
      within(panel).getByText('$.required[0]: "x" is not declared in properties')
    ).toBeVisible()
    expect(status()).toBe('Draft · 4 unsaved changes')
  })

  it('clears an enum a field edit leaves stale, and says so', async () => {
    const schema = {
      type: 'object' as const,
      properties: { a: { type: 'string' as const } },
      enum: [{ a: 'x' }]
    }
    open(graphWith({ output_schema: schema }))
    const panel = inspect('extract', 'Extract')
    fireEvent.click(within(panel).getByRole('button', { name: /Output schema/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Add field' }))

    await expectPending([
      updated('extract', {
        ...extractSpec,
        output_schema: {
          type: 'object',
          properties: { a: { type: 'string' }, field: { type: 'string' } },
          required: ['field']
        }
      })
    ])
    expect(
      within(panel).getByText(
        'The enum no longer fit this shape, so it was cleared. Set it again under As JSON.'
      )
    ).toBeVisible()
  })

  it.each([
    [{ type: 'object', required: 42 }, '$: required must be an array of strings'],
    [{ type: 'toString' }, '$: unsupported type "toString"']
  ])('a stored schema the host refuses (%j) shows why and stays repairable as JSON', (schema, why) => {
    open(graphWith({ output_schema: schema as unknown as typeof extractSpec.output_schema }))
    const panel = inspect('extract', 'Extract')
    expect(within(panel).getByText(`The host refuses this schema: ${why}`)).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: /Output schema/ }))
    expect(within(panel).queryByRole('button', { name: 'Add field' })).toBeNull()
    expect(within(panel).getByLabelText('As JSON')).toBeVisible()
  })

  it('keeps a prompt or schema name typed while Save runs, and says why', async () => {
    open(graphWith({ output_schema: { type: 'object', properties: { a: { type: 'string' } } } }))
    const panel = inspect('extract', 'Extract')
    enter(within(panel).getByLabelText('Max attempts'), '3')
    api.applyAutomationOps.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const prompt = within(panel).getByLabelText('Prompt')
    enter(prompt, 'Late prompt')
    expect(prompt).toHaveValue('Late prompt')
    fireEvent.click(within(panel).getByRole('button', { name: /Output schema/ }))
    const name = within(panel).getByLabelText('Field a name')
    enter(name, 'late')
    expect(name).toHaveValue('late')
    expect(within(panel).getAllByText('Saving. Try that again once it finishes.')).toHaveLength(2)
    expect(api.applyAutomationOps).toHaveBeenCalledTimes(1)
  })

  describe('tools', () => {
    const switchOf = (panel: HTMLElement, label: string) =>
      within(panel).getByRole('switch', { name: label })

    it('lists the host tool classes, on as stored; a flip is one update_node in host order', async () => {
      open()
      const panel = inspect('extract', 'Extract')
      expect(
        within(panel)
          .getAllByRole('switch')
          .map((s) => s.getAttribute('aria-checked'))
      ).toEqual(['true', 'true', 'false', 'false', 'false', 'false'])
      fireEvent.click(switchOf(panel, 'search'))
      await expectPending([updated('extract', { ...extractSpec, tools: ['read'] })])
      undo()
      expect(switchOf(panel, 'search')).toBeChecked()
    })

    it('a prompt reading a fetched response may not edit or fetch; the warning names the tools', async () => {
      open()
      const panel = inspect('extract', 'Extract')
      expect(within(panel).queryByText(/so it may not use/)).toBeNull()
      fireEvent.click(switchOf(panel, 'edit files'))
      fireEvent.click(switchOf(panel, 'fetch from the network'))

      expect(
        within(panel).getByText(/so it may not use: edit files, fetch from the network\.$/)
      ).toBeVisible()
      expect(
        within(panel).getByText(
          'This agent can take in untrusted data with fetch from the network, so it may not also use: read files, search, edit files.'
        )
      ).toBeVisible()
      await expectPending([
        updated('extract', { ...extractSpec, tools: ['read', 'search', 'edit'] }),
        updated('extract', { ...extractSpec, tools: ['read', 'search', 'edit', 'fetch'] })
      ])
    })

    it('warns of an untrusted flow when the agent reads fetched content and a later step sends out', () => {
      open()
      const panel = inspect('extract', 'Extract')
      expect(within(panel).getByText(UNTRUSTED_FLOW)).toBeVisible()
    })

    it('has no untrusted flow on a trusted prompt with no tools, until it may fetch', () => {
      open(graphWith({ prompt: 'Summarize {{ trigger.kind }}', tools: [] }))
      const panel = inspect('extract', 'Extract')
      expect(within(panel).queryByText(UNTRUSTED_FLOW)).toBeNull()
      fireEvent.click(switchOf(panel, 'fetch from the network'))
      expect(within(panel).getByText(UNTRUSTED_FLOW)).toBeVisible()
    })

    it("a saved agent step is the host's clean sample: read and search on a fetched prompt", async () => {
      open(graphWith({ tools: [] }))
      const panel = inspect('extract', 'Extract')
      fireEvent.click(switchOf(panel, 'search'))
      fireEvent.click(switchOf(panel, 'read files'))

      const tools: AgentTool[] = ['read', 'search']
      // `graph_tests::the_sample_automation_has_no_issues` validates this spec in this graph.
      await expectPending([
        updated('extract', { ...extractSpec, tools: ['search'] }),
        updated('extract', { ...extractSpec, tools })
      ])
      expect(new Set(tools)).toEqual(new Set(extractSpec.tools))
      expect(within(panel).queryByText(/may not/)).toBeNull()
    })
  })

  it('on the phone, the form sits in the sheet with touch-height rows', () => {
    open(graphWith({}), true)
    const panel = inspect('extract', 'Extract')
    expect(panel).toHaveClass('rounded-t-2xl')
    expect(within(panel).getByRole('switch', { name: 'read files' }).parentElement).toHaveClass(
      'pointer-coarse:h-11'
    )
  })
})

describe('McpToolForm', () => {
  it('offers the enabled servers; a pick is one update_node, and undo restores it', async () => {
    open()
    const panel = inspect('label_it', 'Post label')
    fireEvent.click(within(panel).getByRole('combobox', { name: 'Server' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['github', 'files'])
    fireEvent.click(screen.getByRole('option', { name: 'files' }))

    await expectPending([updated('label_it', { ...mcpSpec, server_id: 'fs' })])
    undo()
    expect(within(panel).getByRole('combobox', { name: 'Server' })).toHaveTextContent('github')
  })

  it("picks a tool from the server's list, and shows the picked tool's description", async () => {
    open()
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByText('Add labels to an issue')).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: /^Tool/ }))
    fireEvent.click(screen.getByRole('option', { name: /create_issue/ }))

    await expectPending([updated('label_it', { ...mcpSpec, tool: 'create_issue' })])
  })

  it('searches a long tool list', () => {
    seedMcp(Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` })))
    open()
    const panel = inspect('label_it', 'Post label')
    fireEvent.click(within(panel).getByRole('button', { name: /^Tool/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tools' }), {
      target: { value: 'tool_1' }
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'tool_1',
      'tool_10',
      'tool_11'
    ])

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search tools' }), { key: 'Escape' })
    fireEvent.click(within(panel).getByRole('button', { name: /^Tool/ }))
    expect(screen.getByRole('textbox', { name: 'Search tools' })).toHaveValue('')
    expect(screen.getAllByRole('option')).toHaveLength(12)
  })

  it('Enter in the search picks the first match; Enter on another option does not', async () => {
    seedMcp(Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` })))
    open()
    const panel = inspect('label_it', 'Post label')
    fireEvent.click(within(panel).getByRole('button', { name: /^Tool/ }))
    fireEvent.keyDown(screen.getByRole('option', { name: 'tool_3' }), { key: 'Enter' })
    expect(api.previewAutomationOps).not.toHaveBeenCalled()

    const search = screen.getByRole('textbox', { name: 'Search tools' })
    fireEvent.change(search, { target: { value: 'tool_5' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await expectPending([updated('label_it', { ...mcpSpec, tool: 'tool_5' })])
  })

  it('lists the tools of a server nothing has listed yet', () => {
    seedMcp(null)
    open()
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByText('Listing the tools of github…')).toBeVisible()
    expect(within(panel).getByRole('button', { name: /^Tool/ })).toBeDisabled()
    expect(useAcpStore.getState().loadMcpTools).toHaveBeenCalledWith('gh')
  })

  it('says Tool not found when the server has no such tool, and the card says it too', async () => {
    seedMcp([{ name: 'create_issue' }])
    const detail = open()
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByText('Tool not found. github has no tool add_labels.')).toBeVisible()

    api.previewAutomationOps.mockResolvedValue(
      ok({
        ...detail,
        issues: [
          {
            node_id: id('label_it'),
            code: 'unknown_mcp_tool',
            message: 'MCP server "gh" has no tool "add_labels"; it has: create_issue'
          }
        ]
      })
    )
    enter(within(panel).getByLabelText('Timeout'), '30')
    const card = document.querySelector<HTMLElement>('.react-flow__node[data-id="label_it"]')
    await waitFor(() =>
      expect(within(card as HTMLElement).getByText('Tool not found')).toBeVisible()
    )
  })

  it('says Server not configured for a server the registry does not have', () => {
    open({
      ...graphWith({}),
      nodes: graphWith({}).nodes.map((n) =>
        n.id === 'label_it' ? { ...n, spec: { ...mcpSpec, server_id: 'gone' } } : n
      )
    })
    const panel = inspect('label_it', 'Post label')
    expect(
      within(panel).getByText('Server not configured. Add it, or turn it on, in the MCP settings.')
    ).toBeVisible()
    expect(within(panel).getByRole('combobox', { name: 'Server' })).toHaveTextContent(
      'gone (not configured)'
    )
    expect(within(panel).getByRole('button', { name: /^Tool/ })).toBeDisabled()
  })

  it('shows a listing that failed before it loaded, and lists again on request', () => {
    seedMcp(null)
    const probeMcpServer = vi.fn(async () => {})
    useAcpStore.setState({
      mcpProbeStatus: { gh: 'disconnected' },
      mcpProbeError: { gh: 'IPC transport down' },
      probeMcpServer
    })
    open()
    const panel = inspect('label_it', 'Post label')
    expect(
      within(panel).getByText('github did not list its tools: IPC transport down')
    ).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: 'List again' }))
    expect(probeMcpServer).toHaveBeenCalledWith('gh')
  })

  it('names the timeout unit to assistive technology', () => {
    open()
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByLabelText('Timeout')).toHaveAccessibleDescription('seconds')
  })

  it('says why a server listed no tools', () => {
    seedMcp([])
    useAcpStore.setState({ mcpProbeStatus: { gh: 'authRequired' } })
    open()
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByText('github did not list its tools: needs a sign-in')).toBeVisible()
  })

  it('adds an argument whose value is a template', async () => {
    open()
    const panel = inspect('label_it', 'Post label')
    fireEvent.click(within(panel).getByRole('button', { name: 'Add argument' }))
    enter(within(panel).getByLabelText('Argument 1 name'), 'labels')
    enter(within(panel).getByLabelText('Argument 1 value'), '{{ nodes.shape.output }}')

    await expectPending([
      updated('label_it', { ...mcpSpec, arguments: [{ name: '', value: '' }] }),
      updated('label_it', { ...mcpSpec, arguments: [{ name: 'labels', value: '' }] }),
      updated('label_it', {
        ...mcpSpec,
        arguments: [{ name: 'labels', value: '{{ nodes.shape.output }}' }]
      })
    ])
  })
})

describe('McpToolForm arguments from the tool input schema', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name' },
      kind: { type: 'string', enum: ['bug', 'feature'] },
      count: { type: 'integer' },
      weight: { type: 'number' },
      notify: { type: 'boolean', description: 'Ping the assignee' },
      labels: { type: 'array', items: { type: 'string' } }
    },
    required: ['repo', 'kind']
  }
  const withArgs = (args: NamedTemplate[]): Graph => {
    const graph = graphWith({})
    return {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'label_it' ? { ...n, spec: { ...mcpSpec, arguments: args } } : n
      )
    }
  }
  const start: NamedTemplate[] = [
    { name: 'repo', value: 'acme/app' },
    { name: 'legacy', value: 'x' }
  ]

  beforeEach(() => seedMcp([{ name: 'add_labels', inputSchema }]))

  it('shows a field per property with required marks and descriptions, and keeps unknown arguments', () => {
    open(withArgs(start))
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByLabelText('repo')).toHaveValue('acme/app')
    expect(within(panel).getByRole('combobox', { name: 'kind' })).toHaveTextContent('Pick one')
    expect(within(panel).getByLabelText('count')).toHaveValue('')
    expect(within(panel).getByRole('combobox', { name: 'notify' })).toHaveTextContent('Not set')
    expect(within(panel).getByLabelText('labels').tagName).toBe('TEXTAREA')
    expect(within(panel).getAllByText('Required')).toHaveLength(3)
    expect(within(panel).getByLabelText('repo')).toHaveAttribute('aria-required', 'true')
    expect(within(panel).getByRole('combobox', { name: 'kind' })).toHaveAttribute(
      'aria-required',
      'true'
    )
    expect(within(panel).getByLabelText('count')).not.toHaveAttribute('aria-required')
    expect(within(panel).getByText('owner/name')).toBeVisible()
    expect(within(panel).getByText('Ping the assignee')).toBeVisible()
    expect(within(panel).getByLabelText('Argument 1 name')).toHaveValue('legacy')
  })

  it('each field commits one update_node with the arguments as templates', async () => {
    open(withArgs(start))
    const panel = inspect('label_it', 'Post label')
    choose(panel, 'kind', 'bug')
    choose(panel, 'notify', 'true')
    enter(within(panel).getByLabelText('count'), '3')
    enter(within(panel).getByLabelText('labels'), '["bug"]')
    enter(within(panel).getByLabelText('repo'), '')

    const withArguments = (args: NamedTemplate[]) =>
      updated('label_it', { ...mcpSpec, arguments: args })
    const kind = { name: 'kind', value: 'bug' }
    const notify = { name: 'notify', value: 'true' }
    const count = { name: 'count', value: '3' }
    const labels = { name: 'labels', value: '["bug"]' }
    await expectPending([
      withArguments([...start, kind]),
      withArguments([...start, kind, notify]),
      withArguments([...start, kind, notify, count]),
      withArguments([...start, kind, notify, count, labels]),
      withArguments([start[1], kind, notify, count, labels])
    ])
    expect(within(panel).getByLabelText('repo')).toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses a literal the type cannot read, but takes a template', async () => {
    open(withArgs([]))
    const panel = inspect('label_it', 'Post label')
    enter(within(panel).getByLabelText('weight'), 'heavy')
    expect(within(panel).getByText('Not a valid number')).toBeVisible()
    enter(within(panel).getByLabelText('count'), '1.5')
    expect(within(panel).getByText('Not a valid integer')).toBeVisible()
    enter(within(panel).getByLabelText('labels'), '[bug')
    expect(within(panel).getByText('Not a valid array')).toBeVisible()
    enter(within(panel).getByLabelText('labels'), '{{ nodes.shape.output }}')

    await expectPending([
      updated('label_it', {
        ...mcpSpec,
        arguments: [{ name: 'labels', value: '{{ nodes.shape.output }}' }]
      })
    ])
  })

  it('keeps a typed argument while Save runs, and says why', () => {
    open(withArgs(start))
    const panel = inspect('label_it', 'Post label')
    enter(within(panel).getByLabelText('count'), '3')
    api.applyAutomationOps.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const weight = within(panel).getByLabelText('weight')
    enter(weight, '2.5')
    expect(weight).toHaveValue('2.5')
    expect(within(panel).getByText('Saving. Try that again once it finishes.')).toBeVisible()
  })

  it('a boolean can go back to not set, and stray boolean text shows to be fixed', async () => {
    open(withArgs([{ name: 'notify', value: 'yes' }]))
    const panel = inspect('label_it', 'Post label')
    const stray = within(panel).getByLabelText('notify')
    expect(stray).toHaveValue('yes')
    expect(within(panel).getByText('Not a valid boolean')).toBeVisible()
    enter(stray, 'false')
    choose(panel, 'notify', 'Not set')

    await expectPending([
      updated('label_it', { ...mcpSpec, arguments: [{ name: 'notify', value: 'false' }] }),
      updated('label_it', { ...mcpSpec, arguments: [] })
    ])
  })

  it('keeps an enum value outside the list in the select, marked, until an option is picked', async () => {
    open(withArgs([{ name: 'kind', value: 'chore' }]))
    const panel = inspect('label_it', 'Post label')
    const kind = within(panel).getByRole('combobox', { name: 'kind' })
    expect(kind).toHaveTextContent('chore (not an option)')
    expect(within(panel).getByText("Not one of the tool's options")).toBeVisible()
    choose(panel, 'kind', 'feature')

    await expectPending([
      updated('label_it', { ...mcpSpec, arguments: [{ name: 'kind', value: 'feature' }] })
    ])
  })

  it('shows a declared name given twice as a row that can be removed', async () => {
    open(withArgs([...start, { name: 'repo', value: 'acme/other' }]))
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByLabelText('repo')).toHaveValue('acme/app')
    expect(within(panel).getByLabelText('Argument 2 name')).toHaveValue('repo')
    expect(
      within(panel).getByText(
        'A name above is given again here; the host refuses a name given twice.'
      )
    ).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove argument repo' }))

    await expectPending([updated('label_it', { ...mcpSpec, arguments: start })])
  })

  it('adds an argument the schema does not name, unless the tool refuses others', () => {
    open(withArgs([]))
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByRole('button', { name: 'Add argument' })).toBeVisible()
    cleanup()
    seedMcp([{ name: 'add_labels', inputSchema: { ...inputSchema, additionalProperties: false } }])
    open(withArgs([]))
    const closed = inspect('label_it', 'Post label')
    expect(within(closed).queryByRole('button', { name: 'Add argument' })).toBeNull()
  })

  it('with no input schema, keeps the name and value rows', () => {
    seedMcp([{ name: 'add_labels', inputSchema: null }])
    open(withArgs(start))
    const panel = inspect('label_it', 'Post label')
    expect(within(panel).getByLabelText('Argument 1 name')).toHaveValue('repo')
    expect(within(panel).queryByRole('combobox', { name: 'kind' })).toBeNull()
  })
})
