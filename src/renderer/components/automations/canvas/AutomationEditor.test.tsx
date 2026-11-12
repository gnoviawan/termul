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

function open(phone = false) {
  const onChanged = vi.fn()
  render(<AutomationEditor detail={detail} phone={phone} onClose={vi.fn()} onChanged={onChanged} />)
  return { onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()
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
    expect(status()).toBe('Draft · 1 unsaved change')
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
})
