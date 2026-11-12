import type { AutomationNode, Edge, NodeId } from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detailWith } from '@/lib/test-utils/automation-fixtures'

const api = vi.hoisted(() => ({
  applyAutomationOps: vi.fn(),
  approveAutomation: vi.fn(),
  getAutomation: vi.fn(),
  onAutomationChanged: vi.fn((_listener: unknown) => () => {}),
  previewAutomationOps: vi.fn(),
  setAutomationLayout: vi.fn()
}))
vi.mock('@/lib/automation-api', () => api)
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
/** Card renders per node id, to prove a gesture elsewhere does not redraw them. */
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('./nodes/NodeCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nodes/NodeCard')>()
  return {
    ...actual,
    NodeCard: (props: Parameters<typeof actual.NodeCard>[0]) => {
      const key = props.data.kind === 'trigger' ? 'trigger' : props.data.node.id
      renders.set(key, (renders.get(key) ?? 0) + 1)
      return actual.NodeCard(props)
    }
  }
})

import { AutomationEditor } from './AutomationEditor'

const id = (value: string): NodeId => value as NodeId
const node = (nodeId: string, label: string, spec: AutomationNode['spec']): AutomationNode => ({
  id: id(nodeId),
  label,
  spec
})
const nodes = [
  node('fetch', 'Fetch', {
    kind: 'http',
    method: 'GET',
    url: 'https://api.example.com',
    headers: [],
    body: null,
    allowed_hosts: ['api.example.com']
  }),
  node('check', 'Check', {
    kind: 'condition',
    left: '{{nodes.fetch.output}}',
    op: 'exists',
    right: null
  }),
  node('shape', 'Shape', { kind: 'transform', fields: [] })
]
const edges: Edge[] = [
  { from: 'trigger', port: 'out', to: id('fetch') },
  { from: id('fetch'), port: 'out', to: id('check') }
]
const detail = detailWith({
  revision: 7,
  approved_revision: 7,
  graph: { nodes, edges },
  layout: {}
})
const ok = <T,>(data: T) => ({ success: true as const, data })

function handle(nodeId: string, handleId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`
  )
  if (!element) throw new Error(`no handle ${nodeId}:${handleId}`)
  return element
}
function card(nodeId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
  if (!element) throw new Error(`no card for ${nodeId}`)
  return element
}
const edgeCount = () => document.querySelectorAll('.react-flow__edge').length
const status = () => screen.getByTestId('draft-status').textContent

function open(phone = false, shown = detail) {
  const onChanged = vi.fn()
  render(<AutomationEditor detail={shown} phone={phone} onClose={vi.fn()} onChanged={onChanged} />)
  return { onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()
  renders.clear()
  // React Flow reads the element under the pointer to resolve a tapped handle; jsdom has none.
  document.elementFromPoint = () => null
  api.previewAutomationOps.mockResolvedValue(ok(detail))
})

describe('AutomationEditor', () => {
  it('connects two ports and saves the edge as one apply_ops on the base revision', async () => {
    const { onChanged } = open()
    expect(status()).toBe('No unsaved changes')

    fireEvent.click(handle('check', 'true'))
    fireEvent.click(handle('shape', 'in'))

    expect(edgeCount()).toBe(3)
    expect(status()).toBe('Draft · 1 unsaved change')

    const saved = { ...detail.automation, revision: 8 }
    api.applyAutomationOps.mockResolvedValue(ok({ automation: saved, issues: [] }))
    api.setAutomationLayout.mockResolvedValue(ok(saved))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(status()).toBe('No unsaved changes'))
    expect(api.applyAutomationOps).toHaveBeenCalledWith(detail.automation.id, 7, [
      { op: 'connect', edge: { from: 'check', port: 'true', to: 'shape' } }
    ])
    expect(onChanged).toHaveBeenCalled()
  })

  it('refuses an edge that already exists and one that makes a loop', () => {
    open()

    fireEvent.click(handle('fetch', 'out'))
    fireEvent.click(handle('check', 'in'))
    expect(toast).toHaveBeenLastCalledWith('Those ports are already connected.')

    fireEvent.click(handle('check', 'false'))
    fireEvent.click(handle('fetch', 'in'))
    expect(toast).toHaveBeenLastCalledWith('That edge would make a loop.')

    expect(edgeCount()).toBe(2)
    expect(status()).toBe('No unsaved changes')
  })

  it('on the phone, taps a port, then any card to connect', () => {
    open(true)

    fireEvent.click(handle('check', 'true'))
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Tap a node to connect')
    expect(banner).toHaveTextContent('from Check · true')

    fireEvent.click(within(card('shape')).getByText('Shape'))

    expect(screen.queryByText('Tap a node to connect')).toBeNull()
    expect(edgeCount()).toBe(3)
    expect(status()).toBe('1 unsaved')
  })

  it('on the phone, shows Approve while clean and only Discard and Save while dirty', () => {
    open(
      true,
      detailWith({ revision: 7, approved_revision: 6, graph: { nodes, edges }, layout: {} })
    )
    const button = (name: string) => screen.queryByRole('button', { name })

    expect(button('Approve')).not.toBeNull()
    expect([button('Discard'), button('Save'), button('Approve and arm')]).toEqual([
      null,
      null,
      null
    ])

    fireEvent.click(handle('check', 'true'))
    fireEvent.click(within(card('shape')).getByText('Shape'))

    expect(status()).toBe('1 unsaved')
    expect(button('Discard')).not.toBeNull()
    expect(button('Save')).not.toBeNull()
    expect(button('Approve')).toBeNull()
  })

  it('cancels a tap-to-connect from the banner', () => {
    open(true)
    fireEvent.click(handle('check', 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(card('shape')).getByText('Shape'))
    expect(edgeCount()).toBe(2)
  })

  it('deletes the selected step with the keyboard, and Ctrl+Z brings it back', () => {
    open()
    const editor = screen.getByTestId('automation-editor')

    fireEvent.click(within(card('check')).getByText('Check'))
    fireEvent.keyDown(card('check'), { key: 'Delete' })

    expect(document.querySelector('.react-flow__node[data-id="check"]')).toBeNull()
    expect(edgeCount()).toBe(1)
    expect(status()).toBe('Draft · 1 unsaved change')

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    expect(card('check')).toBeInTheDocument()
    expect(edgeCount()).toBe(2)
    expect(status()).toBe('No unsaved changes')

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(document.querySelector('.react-flow__node[data-id="check"]')).toBeNull()
  })

  it('deletes from the toolbar, and never the trigger', () => {
    open()
    const tools = within(screen.getByRole('toolbar', { name: 'Canvas tools' }))
    expect(tools.getByRole('button', { name: 'Delete selected' })).toBeDisabled()

    fireEvent.click(within(card('trigger')).getByText('Schedule'))
    fireEvent.click(tools.getByRole('button', { name: 'Delete selected' }))
    expect(card('trigger')).toBeInTheDocument()

    fireEvent.click(within(card('shape')).getByText('Shape'))
    fireEvent.click(tools.getByRole('button', { name: 'Delete selected' }))
    expect(document.querySelector('.react-flow__node[data-id="shape"]')).toBeNull()
  })

  it('shows dry-run issues on the card and in the Issues dock', async () => {
    api.previewAutomationOps.mockResolvedValue(
      ok({
        ...detail,
        issues: [
          {
            node_id: id('shape'),
            code: 'unreachable',
            message: 'node shape is not reachable from the trigger'
          }
        ]
      })
    )
    open()
    fireEvent.click(handle('check', 'true'))
    fireEvent.click(handle('shape', 'in'))

    await waitFor(() =>
      expect(within(card('shape')).getByTestId('card-issues')).toHaveTextContent('1')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Issues (1)' }))
    expect(screen.getByText('node shape is not reachable from the trigger')).toBeInTheDocument()
    expect(api.previewAutomationOps).toHaveBeenCalledWith(detail.automation.id, 7, [
      { op: 'connect', edge: { from: 'check', port: 'true', to: 'shape' } }
    ])
  })

  it('replays the draft on a newer head when Save meets a conflict', async () => {
    let announce: (change: unknown) => void = () => {}
    api.onAutomationChanged.mockImplementation((listener) => {
      announce = listener as typeof announce
      return () => {}
    })
    open()
    fireEvent.click(handle('check', 'true'))
    fireEvent.click(handle('shape', 'in'))
    fireEvent.click(within(card('fetch')).getByText('Fetch'))
    fireEvent.keyDown(card('fetch'), { key: 'Delete' })

    act(() =>
      announce({
        project_id: 'p',
        automation_id: detail.automation.id,
        proposed: true,
        proposed_by: 'Claude Code'
      })
    )
    // The agent removed `shape` and saved revision 8.
    const head = detailWith({
      revision: 8,
      graph: { nodes: nodes.filter((n) => n.id !== 'shape'), edges },
      layout: {}
    })
    api.applyAutomationOps.mockResolvedValue({
      success: false,
      error: 'conflict',
      code: 'revision_conflict'
    })
    api.getAutomation.mockResolvedValue(ok(head))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const banner = await screen.findByText('Updated by Claude Code while you edited')
    const conflict = banner.closest('[role="status"]') as HTMLElement
    expect(within(conflict).getByText('1 edit no longer apply:')).toBeInTheDocument()
    expect(within(conflict).getByText('Connect Check → Shape (true)')).toBeInTheDocument()
    expect(status()).toBe('Draft · 1 unsaved change')
    expect(document.querySelector('.react-flow__node[data-id="fetch"]')).toBeNull()
  })

  it('holds undo and edits while Save is running', async () => {
    let answer: (value: unknown) => void = () => {}
    api.applyAutomationOps.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    api.setAutomationLayout.mockResolvedValue(ok(detail.automation))
    open()
    const editor = screen.getByTestId('automation-editor')
    fireEvent.click(handle('check', 'true'))
    fireEvent.click(handle('shape', 'in'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    expect(edgeCount()).toBe(3)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    // Closing, discarding or adding now would race the request.
    expect(screen.getByRole('button', { name: 'Close the editor' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add a step' })).toBeDisabled()

    const saved = {
      ...detail.automation,
      revision: 8,
      graph: {
        nodes,
        edges: [...edges, { from: id('check'), port: 'true' as const, to: id('shape') }]
      }
    }
    await act(async () => answer(ok({ automation: saved, issues: [] })))
    await waitFor(() => expect(status()).toBe('No unsaved changes'))
    // The saved edit is still undoable, as a new pending change.
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    expect(edgeCount()).toBe(2)
    expect(status()).toBe('Draft · 1 unsaved change')
  })

  it('adds a step from the toolbar menu at the centre, unconnected', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }))
    const menu = screen.getByRole('dialog', { name: 'Add a step' })
    expect(
      within(menu)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual([
      'HTTP',
      'Agent',
      'MCP tool',
      'Condition',
      'For each',
      'Merge',
      'Wait',
      'Fail',
      'Approval',
      'Transform'
    ])
    fireEvent.change(within(menu).getByRole('textbox', { name: 'Search steps' }), {
      target: { value: 'wai' }
    })
    // A real click starts with a pointerdown, which bubbles out of the menu's portal.
    fireEvent.pointerDown(within(menu).getByRole('button', { name: 'Wait' }))
    fireEvent.click(within(menu).getByRole('button', { name: 'Wait' }))

    expect(within(card('wait')).getByText('Wait')).toBeInTheDocument()
    expect(edgeCount()).toBe(2)
    expect(status()).toBe('Draft · 1 unsaved change')
    // On desktop the new step opens in the floating inspector.
    expect(
      within(screen.getByTestId('automation-inspector')).getByRole('heading', { name: 'Wait' })
    ).toBeInTheDocument()
  })

  it('on the phone, every way of adding a step selects it and leaves the sheet closed', async () => {
    open(true)
    const pick = (kind: string) =>
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Add a step' })).getByRole('button', {
          name: kind
        })
      )
    const expectAdded = (id: string) => {
      expect(card(id)).toHaveClass('selected')
      expect(screen.queryByTestId('automation-inspector')).toBeNull()
      expect(screen.getByRole('region', { name: 'Dock' })).toBeVisible()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }))
    pick('Wait')
    await waitFor(() => expectAdded('wait'))

    fireEvent.click(screen.getByRole('button', { name: 'Add a step after Check (true)' }))
    pick('Transform')
    await waitFor(() => expectAdded('transform'))

    fireEvent.click(handle('check', 'false'))
    fireEvent.click(document.querySelector('.react-flow__pane') as Element)
    pick('HTTP')
    await waitFor(() => expectAdded('http'))

    fireEvent.click(
      document.querySelector('.react-flow__edge[data-id="fetch:out->check"]') as Element
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Insert a step here' }))
    pick('Merge')
    await waitFor(() => expectAdded('merge'))

    fireEvent.drop(screen.getByRole('group', { name: 'Automation canvas' }), {
      dataTransfer: { getData: () => 'approval', types: ['application/x-troupe-node-kind'] },
      clientX: 200,
      clientY: 200
    })
    await waitFor(() => expectAdded('approval'))

    // A tap on the new card opens it, as for any card.
    fireEvent.click(card('approval'))
    expect(screen.getByTestId('automation-inspector')).toHaveClass('rounded-t-2xl')
  })

  it('chains a new step from the dangling + of an open output', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add a step after Check (true)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Transform' }))

    expect(card('transform')).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="edge-label-check:true->transform"]')
    ).not.toBeNull()
    // `check:true` is taken now, so its "+" is gone.
    expect(screen.queryByRole('button', { name: 'Add a step after Check (true)' })).toBeNull()
  })

  it('inserts a step into the middle of an edge', async () => {
    api.applyAutomationOps.mockResolvedValue(ok({ automation: detail.automation, issues: [] }))
    open()
    fireEvent.click(
      document.querySelector('.react-flow__edge[data-id="fetch:out->check"]') as Element
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Insert a step here' }))
    const menu = screen.getByRole('dialog', { name: 'Add a step' })
    // A step in an edge's middle passes the run on; Fail cannot.
    expect(within(menu).queryByRole('button', { name: 'Fail' })).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: 'Wait' }))

    expect(document.querySelector('.react-flow__edge[data-id="fetch:out->check"]')).toBeNull()
    expect(document.querySelector('.react-flow__edge[data-id="fetch:out->wait"]')).not.toBeNull()
    expect(document.querySelector('.react-flow__edge[data-id="wait:out->check"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.applyAutomationOps).toHaveBeenCalled())
    expect(api.applyAutomationOps.mock.calls[0][2]).toEqual([
      {
        op: 'add_node',
        node: { id: 'wait', label: 'Wait', spec: { kind: 'wait', duration_ms: 60_000 } }
      },
      { op: 'disconnect', edge: { from: 'fetch', port: 'out', to: 'check' } },
      { op: 'connect', edge: { from: 'fetch', port: 'out', to: 'wait' } },
      { op: 'connect', edge: { from: 'wait', port: 'out', to: 'check' } }
    ])
  })

  it('takes a step dragged in from the menu and dropped on the canvas', () => {
    open()
    const data = { getData: () => 'merge', types: ['application/x-troupe-node-kind'] }
    fireEvent.drop(screen.getByRole('group', { name: 'Automation canvas' }), {
      dataTransfer: data,
      clientX: 200,
      clientY: 200
    })
    expect(within(card('merge')).getByText('Merge')).toBeInTheDocument()
  })

  it('on the phone, a tap on blank canvas while connecting offers a new step there', () => {
    open(true)
    fireEvent.click(handle('check', 'false'))
    fireEvent.click(document.querySelector('.react-flow__pane') as Element)

    const sheet = screen.getByRole('dialog', { name: 'Add a step' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'HTTP' }))

    expect(card('http')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="edge-label-check:false->http"]')).not.toBeNull()
  })

  it('takes focus when it opens, so Ctrl+Z works without a click first', () => {
    open()
    const editor = screen.getByTestId('automation-editor')
    expect(document.activeElement).toBe(editor)

    fireEvent.click(handle('check', 'true'))
    fireEvent.click(handle('shape', 'in'))
    editor.focus()
    fireEvent.keyDown(document.activeElement as Element, { key: 'z', ctrlKey: true })
    expect(edgeCount()).toBe(2)
  })

  it('Enter on a menu row adds that row; Enter in the search field adds the top match', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }))
    const menu = screen.getByRole('dialog', { name: 'Add a step' })
    const wait = within(menu).getByRole('button', { name: 'Wait' })
    wait.focus()
    fireEvent.keyDown(wait, { key: 'Enter' })
    // The browser turns Enter on a button into a click; the menu must not add HTTP instead.
    expect(document.querySelector('.react-flow__node[data-id="http"]')).toBeNull()
    fireEvent.click(wait)
    expect(card('wait')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }))
    const again = screen.getByRole('dialog', { name: 'Add a step' })
    fireEvent.keyDown(within(again).getByRole('textbox', { name: 'Search steps' }), {
      key: 'Enter'
    })
    expect(card('http')).toBeInTheDocument()
  })

  it('a second request for the menu opens a fresh menu that the first cannot close', () => {
    open()
    const add = screen.getByRole('button', { name: 'Add a step' })
    fireEvent.click(add)
    fireEvent.pointerDown(add)
    fireEvent.click(add)
    const menu = screen.getByRole('dialog', { name: 'Add a step' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Merge' }))
    expect(card('merge')).toBeInTheDocument()
  })

  it('hovering an edge redraws no card', async () => {
    open()
    const before = new Map(renders)
    const edge = document.querySelector('.react-flow__edge[data-id="fetch:out->check"]') as Element
    fireEvent.mouseEnter(edge)
    expect(await screen.findByRole('button', { name: 'Insert a step here' })).toBeInTheDocument()
    for (const [nodeId, count] of before) expect(renders.get(nodeId), nodeId).toBe(count)
  })
})
