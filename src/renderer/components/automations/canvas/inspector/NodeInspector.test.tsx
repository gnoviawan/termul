import type {
  AutomationNode,
  AutomationOp,
  Edge,
  NodeId,
  NodeSpec
} from '@shared/types/automation.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detailWith } from '@/lib/test-utils/automation-fixtures'

const api = vi.hoisted(() => ({
  applyAutomationOps: vi.fn(),
  approveAutomation: vi.fn(),
  getAutomation: vi.fn(),
  onAutomationChanged: vi.fn((_listener: unknown) => () => {}),
  previewAutomationOps: vi.fn(),
  previewSchedule: vi.fn(),
  setAutomationLayout: vi.fn()
}))
vi.mock('@/lib/automation-api', () => api)
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { AutomationEditor } from '../AutomationEditor'

const id = (value: string) => value as NodeId
const node = (nodeId: string, label: string, spec: NodeSpec): AutomationNode => ({
  id: id(nodeId),
  label,
  spec
})
const edge = (from: string, to: string, port: Edge['port'] = 'out'): Edge => ({
  from: from as Edge['from'],
  port,
  to: id(to)
})

const specs = {
  fetch: {
    kind: 'http',
    method: 'GET',
    url: 'https://api.example.com/items',
    headers: [],
    body: null,
    allowed_hosts: ['api.example.com']
  },
  check: { kind: 'condition', left: '', op: 'exists', right: null },
  each: { kind: 'for_each', items: '{{ nodes.fetch.output }}', max_iterations: 10 },
  shape: { kind: 'transform', fields: [] },
  stop: { kind: 'fail', message: 'Stopped' },
  pause: { kind: 'wait', duration_ms: 60_000 },
  ask: { kind: 'approval', message: 'Ship it?', timeout_ms: 86_400_000 },
  join: { kind: 'merge', mode: 'any' },
  classify: {
    kind: 'agent',
    agent_id: 'claude-code',
    model: 'sonnet',
    prompt: 'Label it',
    output_schema: { type: 'string' },
    timeout_ms: 120_000,
    max_attempts: 2,
    tools: ['read']
  }
} satisfies Record<string, NodeSpec>

const detail = detailWith({
  revision: 7,
  approved_revision: 7,
  trigger: { kind: 'manual' },
  graph: {
    nodes: [
      node('fetch', 'Fetch', specs.fetch),
      node('check', 'Check', specs.check),
      node('each', 'Each', specs.each),
      node('shape', 'Shape', specs.shape),
      node('stop', 'Stop', specs.stop),
      node('pause', 'Pause', specs.pause),
      node('ask', 'Ask', specs.ask),
      node('join', 'Join', specs.join),
      node('classify', 'Classify', specs.classify)
    ],
    edges: [
      edge('trigger', 'fetch'),
      edge('fetch', 'check'),
      edge('check', 'each', 'true'),
      edge('each', 'shape', 'item'),
      edge('check', 'stop', 'false'),
      edge('each', 'pause'),
      edge('pause', 'ask'),
      edge('ask', 'join'),
      edge('fetch', 'join', 'error')
    ]
  },
  layout: {}
})
const automationId = detail.automation.id
const ok = <T,>(data: T) => ({ success: true as const, data })

/** Taps the card showing `text` and returns the inspector it opens. */
function inspect(nodeId: string, text: string, title = text): HTMLElement {
  const card = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
  if (!card) throw new Error(`no card for ${nodeId}`)
  fireEvent.click(within(card).getByText(text))
  return screen.getByRole('complementary', { name: `Inspect ${title}` })
}

/** Types `value` and leaves the field, which commits it. */
function enter(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } })
  fireEvent.blur(field)
}

function choose(panel: HTMLElement, label: string, option: string): void {
  fireEvent.click(within(panel).getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

/** The ops the draft holds, as its dry run sends them to the host. */
async function expectPending(ops: AutomationOp[]): Promise<void> {
  await waitFor(() =>
    expect(api.previewAutomationOps).toHaveBeenLastCalledWith(automationId, 7, ops)
  )
}

const status = () => screen.getByTestId('draft-status').textContent
const undo = () =>
  fireEvent.keyDown(screen.getByTestId('automation-editor'), { key: 'z', ctrlKey: true })

function open(phone = false) {
  render(<AutomationEditor detail={detail} phone={phone} onClose={vi.fn()} onChanged={vi.fn()} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  document.elementFromPoint = () => null
  api.previewAutomationOps.mockResolvedValue(ok(detail))
  api.previewSchedule.mockResolvedValue(ok({ next_runs: [], error: null }))
})

describe('NodeInspector', () => {
  it('http: a URL edit is one update_node with the whole spec, and undo restores it', async () => {
    open()
    const panel = inspect('fetch', 'Fetch')
    const url = within(panel).getByLabelText('URL')

    fireEvent.change(url, { target: { value: 'https://api.example.com/v2' } })
    expect(status()).toBe('No unsaved changes')
    fireEvent.blur(url)

    expect(status()).toBe('Draft · 1 unsaved change')
    await expectPending([
      {
        op: 'update_node',
        id: id('fetch'),
        spec: { ...specs.fetch, url: 'https://api.example.com/v2' }
      }
    ])

    undo()
    expect(status()).toBe('No unsaved changes')
    expect(url).toHaveValue('https://api.example.com/items')
  })

  it('http: a host outside the allowed hosts shows inline, and Allow adds it', async () => {
    open()
    const panel = inspect('fetch', 'Fetch')
    enter(within(panel).getByLabelText('URL'), 'https://hooks.example.org/x')

    expect(within(panel).getByText('hooks.example.org is not an allowed host')).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: 'Allow hooks.example.org' }))

    expect(within(panel).queryByText('hooks.example.org is not an allowed host')).toBeNull()
    expect(within(panel).getByLabelText('Allowed hosts')).toHaveValue(
      'api.example.com, hooks.example.org'
    )
    expect(status()).toBe('Draft · 2 unsaved changes')
    await expectPending([
      {
        op: 'update_node',
        id: id('fetch'),
        spec: { ...specs.fetch, url: 'https://hooks.example.org/x' }
      },
      {
        op: 'update_node',
        id: id('fetch'),
        spec: {
          ...specs.fetch,
          url: 'https://hooks.example.org/x',
          allowed_hosts: ['api.example.com', 'hooks.example.org']
        }
      }
    ])
  })

  it('http: the method commits on pick, and Enter commits a header', async () => {
    open()
    const panel = inspect('fetch', 'Fetch')
    choose(panel, 'Method', 'POST')
    fireEvent.click(within(panel).getByRole('button', { name: 'Add header' }))
    const name = within(panel).getByLabelText('Header 1 name')
    fireEvent.change(name, { target: { value: 'Accept' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    const post = { ...specs.fetch, method: 'POST' as const }
    await expectPending([
      { op: 'update_node', id: id('fetch'), spec: post },
      { op: 'update_node', id: id('fetch'), spec: { ...post, headers: [{ name: '', value: '' }] } },
      {
        op: 'update_node',
        id: id('fetch'),
        spec: { ...post, headers: [{ name: 'Accept', value: '' }] }
      }
    ])
  })

  it('keeps a field edit that arrives while Save runs, and says why', async () => {
    open()
    const panel = inspect('fetch', 'Fetch')
    enter(within(panel).getByLabelText('Body'), '{}')
    api.applyAutomationOps.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const url = within(panel).getByLabelText('URL')
    enter(url, 'https://api.example.com/late')

    expect(url).toHaveValue('https://api.example.com/late')
    expect(within(panel).getByText('Saving. Try that again once it finishes.')).toBeVisible()
    expect(toast).toHaveBeenLastCalledWith('Saving. Try that again once it finishes.')
    expect(api.applyAutomationOps).toHaveBeenCalledWith(automationId, 7, [
      { op: 'update_node', id: id('fetch'), spec: { ...specs.fetch, body: '{}' } }
    ])
  })

  it('renames a step through update_node with only the label', async () => {
    open()
    const panel = inspect('fetch', 'Fetch')
    enter(within(panel).getByLabelText('Label'), '  Fetch issues ')

    await expectPending([{ op: 'update_node', id: id('fetch'), label: 'Fetch issues' }])
    expect(screen.getByRole('complementary', { name: 'Inspect Fetch issues' })).toBeVisible()

    enter(within(panel).getByLabelText('Label'), ' ')
    expect(within(panel).getByText('A step needs a label')).toBeVisible()
    expect(status()).toBe('Draft · 1 unsaved change')
  })

  it('condition: typing {{ offers the trigger and ancestors only, and a pick writes the reference', async () => {
    open()
    const panel = inspect('check', 'Check')
    const left = within(panel).getByLabelText('Value')

    fireEvent.change(left, { target: { value: '{{' } })
    const options = within(screen.getByRole('listbox', { name: 'References' }))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual([
      'Trigger · manual, scheduled or catch_uptrigger.kind',
      'Trigger · when the run was due (ms)trigger.scheduled_for',
      'Fetch · HTTPnodes.fetch.output'
    ])

    fireEvent.change(left, { target: { value: '{{ nodes.f' } })
    fireEvent.click(screen.getByRole('option', { name: /nodes\.fetch\.output/ }))
    expect(left).toHaveValue('{{ nodes.fetch.output }}')
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.blur(left)

    choose(panel, 'Check', 'equals')
    await expectPending([
      {
        op: 'update_node',
        id: id('check'),
        spec: { ...specs.check, left: '{{ nodes.fetch.output }}' }
      },
      {
        op: 'update_node',
        id: id('check'),
        spec: { kind: 'condition', left: '{{ nodes.fetch.output }}', op: 'eq', right: '' }
      }
    ])
    expect(within(panel).getByLabelText('Compared with')).toBeVisible()
  })

  it("inside a for_each body offers the loop's item, and the keyboard picks", () => {
    open()
    const panel = inspect('shape', 'Shape')
    fireEvent.click(within(panel).getByRole('button', { name: 'Add field' }))
    const value = within(panel).getByLabelText('Field 1 value')

    fireEvent.change(value, { target: { value: 'n={{ nodes.each.i' } })
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual([
      'Each · the current itemnodes.each.item',
      'Each · the current index, from 0nodes.each.index'
    ])
    fireEvent.keyDown(value, { key: 'ArrowDown' })
    fireEvent.keyDown(value, { key: 'Enter' })

    expect(value).toHaveValue('n={{ nodes.each.index }}')
    expect(within(panel).getByText('Needs a name')).toBeVisible()
  })

  it('shows a template syntax error the host would refuse', async () => {
    open()
    const panel = inspect('stop', 'Stop')
    enter(within(panel).getByLabelText('Message'), 'Failed: {{ nodes.fetch.output')

    expect(within(panel).getByText('An opened {{ is never closed with }}')).toBeVisible()
    await expectPending([
      {
        op: 'update_node',
        id: id('stop'),
        spec: { kind: 'fail', message: 'Failed: {{ nodes.fetch.output' }
      }
    ])
  })

  it('for_each: max iterations outside 1 to 100 shows inline; text that is no number never commits', async () => {
    open()
    const panel = inspect('each', 'Each')
    const max = within(panel).getByLabelText('Max iterations')

    enter(max, '-3')
    expect(within(panel).getByText('Enter a whole number')).toBeVisible()
    expect(status()).toBe('No unsaved changes')

    enter(max, '500')
    expect(within(panel).getByText('Between 1 and 100')).toBeVisible()
    await expectPending([
      { op: 'update_node', id: id('each'), spec: { ...specs.each, max_iterations: 500 } }
    ])

    enter(within(panel).getByLabelText('Items'), '')
    expect(within(panel).getByText('Required')).toBeVisible()
  })

  it('merge: the mode commits on pick', async () => {
    open()
    choose(inspect('join', 'Join'), 'Continue', 'When every branch arrives')
    await expectPending([
      { op: 'update_node', id: id('join'), spec: { kind: 'merge', mode: 'all' } }
    ])
  })

  it('wait: the duration commits in milliseconds and over 7 days shows inline', async () => {
    open()
    const panel = inspect('pause', 'Pause')
    const duration = within(panel).getByLabelText('Wait for')
    expect(duration).toHaveValue('1')
    expect(within(panel).getByRole('combobox', { name: 'Wait for unit' })).toHaveTextContent(
      'minutes'
    )

    enter(duration, '90')
    choose(panel, 'Wait for unit', 'days')
    expect(within(panel).getByText('Wait at most 7 days')).toBeVisible()
    await expectPending([
      { op: 'update_node', id: id('pause'), spec: { kind: 'wait', duration_ms: 5_400_000 } },
      {
        op: 'update_node',
        id: id('pause'),
        spec: { kind: 'wait', duration_ms: 90 * 86_400_000 }
      }
    ])

    undo()
    expect(duration).toHaveValue('90')
    expect(within(panel).queryByText('Wait at most 7 days')).toBeNull()
  })

  it('approval: message and timeout commit; under a minute shows inline', async () => {
    open()
    const panel = inspect('ask', 'Ask')
    enter(within(panel).getByLabelText('Message'), 'Ship {{ nodes.pause.output }}?')
    const timeout = within(panel).getByLabelText('Time out after')
    expect(timeout).toHaveValue('1')
    choose(panel, 'Time out after unit', 'seconds')

    expect(within(panel).getByText('Between 1 minute and 7 days')).toBeVisible()
    await expectPending([
      {
        op: 'update_node',
        id: id('ask'),
        spec: { ...specs.ask, message: 'Ship {{ nodes.pause.output }}?' }
      },
      {
        op: 'update_node',
        id: id('ask'),
        spec: { kind: 'approval', message: 'Ship {{ nodes.pause.output }}?', timeout_ms: 1000 }
      }
    ])
  })

  it('agent: shows its settings read-only under the label', () => {
    open()
    const panel = inspect('classify', 'Classify')
    expect(within(panel).getAllByRole('textbox')).toHaveLength(1)
    expect(within(panel).getByText('claude-code')).toBeVisible()
    expect(within(panel).getByText('tools: read files')).toBeVisible()
  })

  it('lists the dry run issues on this step in the footer', async () => {
    open()
    const panel = inspect('join', 'Join')
    expect(within(panel).getByText('No issues on Join.')).toBeVisible()
    api.previewAutomationOps.mockResolvedValue(
      ok({
        ...detail,
        issues: [
          { node_id: id('join'), code: 'merge_needs_two_inputs', message: 'merge join needs two' },
          { node_id: id('fetch'), code: 'invalid_url', message: 'not this one' }
        ]
      })
    )
    choose(panel, 'Continue', 'When every branch arrives')

    const footer = within(panel).getByRole('region', { name: 'Issues on this step' })
    await waitFor(() => expect(within(footer).getByText('merge join needs two')).toBeVisible())
    expect(within(footer).queryByText('not this one')).toBeNull()
  })

  it('deletes the step from its header, and closes', async () => {
    open()
    const panel = inspect('stop', 'Stop')
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete step' }))

    expect(document.querySelector('.react-flow__node[data-id="stop"]')).toBeNull()
    expect(screen.queryByTestId('automation-inspector')).toBeNull()
    await expectPending([{ op: 'remove_node', id: id('stop') }])
  })

  it('closes from its header and clears the selection', () => {
    open()
    const panel = inspect('fetch', 'Fetch')
    fireEvent.click(within(panel).getByRole('button', { name: 'Close the inspector' }))
    expect(screen.queryByTestId('automation-inspector')).toBeNull()
    expect(document.querySelector('.react-flow__node[data-id="fetch"]')).not.toHaveClass('selected')
  })

  it('on the phone, opens as a sheet in place of the dock', () => {
    open(true)
    expect(screen.getByRole('region', { name: 'Dock' })).toBeVisible()
    inspect('fetch', 'Fetch')
    expect(screen.queryByRole('region', { name: 'Dock' })).toBeNull()
    expect(screen.getByTestId('automation-inspector')).toHaveClass('rounded-t-2xl')
  })
})

describe('TriggerInspector', () => {
  it('switching to a schedule is one set_trigger, previews its next runs, and undo restores manual', async () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const runs = [Date.UTC(2030, 0, 7, 9), Date.UTC(2030, 0, 8, 9)]
    api.previewSchedule.mockResolvedValue(ok({ next_runs: runs, error: null }))
    open()
    const panel = inspect('trigger', 'Manual', 'Trigger')

    choose(panel, 'Runs', 'On a schedule')

    const cron = { kind: 'cron' as const, expr: '0 9 * * 1-5', timezone }
    await expectPending([{ op: 'set_trigger', trigger: { kind: 'schedule', schedule: cron } }])
    await waitFor(() => expect(api.previewSchedule).toHaveBeenLastCalledWith(cron))
    const next = within(panel).getByRole('region', { name: 'Next runs' })
    await waitFor(() => expect(within(next).getAllByRole('listitem')).toHaveLength(2))

    undo()
    expect(within(panel).queryByLabelText('Cron expression')).toBeNull()
    expect(status()).toBe('No unsaved changes')
  })

  it('previews the cron being typed and shows the host error inline', async () => {
    api.previewSchedule.mockResolvedValue(
      ok({ next_runs: [], error: 'invalid cron expression: expected 5 fields' })
    )
    open()
    const panel = inspect('trigger', 'Manual', 'Trigger')
    choose(panel, 'Runs', 'On a schedule')
    fireEvent.change(within(panel).getByLabelText('Cron expression'), { target: { value: '0 9' } })

    await waitFor(() =>
      expect(api.previewSchedule).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'cron', expr: '0 9' })
      )
    )
    expect(
      await within(panel).findByText('invalid cron expression: expected 5 fields')
    ).toBeVisible()

    fireEvent.blur(within(panel).getByLabelText('Cron expression'))
    await expectPending([
      expect.anything(),
      {
        op: 'set_trigger',
        trigger: { kind: 'schedule', schedule: expect.objectContaining({ expr: '0 9' }) }
      }
    ] as AutomationOp[])
  })
})
