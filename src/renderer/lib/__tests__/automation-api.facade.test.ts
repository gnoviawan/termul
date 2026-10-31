import wire from '@shared/types/__fixtures__/automation.json'
import type { AutomationId, RunId } from '@shared/types/automation.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext, mockInvoke, mockLog } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  mockLog: vi.fn(() => Promise.resolve())
}))

vi.mock('../tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('../log-api', () => ({ logFrontendError: mockLog }))

import {
  applyAutomationOps,
  approveAutomation,
  cancelAutomationRun,
  createAutomation,
  deleteAutomation,
  deleteAutomationSecret,
  getAutomation,
  getAutomationRunSteps,
  listAutomationAgents,
  listAutomationRuns,
  listAutomationSecrets,
  listAutomations,
  markAutomationSeen,
  onAutomationChanged,
  previewSchedule,
  publishAutomationChange,
  runAutomationNow,
  setAutomationEnabled,
  setAutomationSecret
} from '../automation-api'

const ID = 'auto-1' as AutomationId
const RUN = 'run/1' as RunId
const detail = { automation: wire.automation, issues: [], policy: wire.run_policy }

interface Case {
  name: string
  call: () => Promise<unknown>
  reply: unknown
  command: string
  args?: Record<string, unknown>
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
}

const CASES: Case[] = [
  {
    name: 'listAutomations',
    call: () => listAutomations('p 1'),
    reply: [wire.automation],
    command: 'automation_list',
    args: { projectId: 'p 1' },
    method: 'GET',
    path: '/api/automations?project_id=p%201'
  },
  {
    name: 'getAutomation',
    call: () => getAutomation(ID),
    reply: detail,
    command: 'automation_get',
    args: { id: ID },
    method: 'GET',
    path: '/api/automations/auto-1'
  },
  {
    name: 'createAutomation',
    call: () => createAutomation('p1', 'Digest'),
    reply: wire.automation,
    command: 'automation_create',
    args: { projectId: 'p1', name: 'Digest' },
    method: 'POST',
    path: '/api/automations',
    body: { project_id: 'p1', name: 'Digest' }
  },
  {
    name: 'applyAutomationOps',
    call: () => applyAutomationOps(ID, 3, [{ op: 'rename', name: 'X' }]),
    reply: wire.apply_ops_result,
    command: 'automation_apply_ops',
    args: { id: ID, baseRevision: 3, ops: [{ op: 'rename', name: 'X' }] },
    method: 'POST',
    path: '/api/automations/auto-1/ops',
    body: { base_revision: 3, ops: [{ op: 'rename', name: 'X' }] }
  },
  {
    name: 'deleteAutomation',
    call: () => deleteAutomation(ID),
    reply: null,
    command: 'automation_delete',
    args: { id: ID },
    method: 'DELETE',
    path: '/api/automations/auto-1'
  },
  {
    name: 'setAutomationEnabled',
    call: () => setAutomationEnabled(ID, false),
    reply: null,
    command: 'automation_set_enabled',
    args: { id: ID, enabled: false },
    method: 'POST',
    path: '/api/automations/auto-1/enabled',
    body: { enabled: false }
  },
  {
    name: 'approveAutomation',
    call: () => approveAutomation(ID, 4),
    reply: null,
    command: 'automation_approve',
    args: { id: ID, revision: 4 },
    method: 'POST',
    path: '/api/automations/auto-1/approve',
    body: { revision: 4 }
  },
  {
    name: 'runAutomationNow',
    call: () => runAutomationNow(ID),
    reply: wire.runs[0],
    command: 'automation_run_now',
    args: { id: ID },
    method: 'POST',
    path: '/api/automations/auto-1/run',
    body: {}
  },
  {
    name: 'cancelAutomationRun',
    call: () => cancelAutomationRun(RUN),
    reply: null,
    command: 'automation_cancel_run',
    args: { runId: RUN },
    method: 'POST',
    path: '/api/automation-runs/run%2F1/cancel',
    body: {}
  },
  {
    name: 'listAutomationRuns',
    call: () => listAutomationRuns(ID, 20),
    reply: wire.runs,
    command: 'automation_list_runs',
    args: { id: ID, limit: 20 },
    method: 'GET',
    path: '/api/automations/auto-1/runs?limit=20'
  },
  {
    name: 'getAutomationRunSteps',
    call: () => getAutomationRunSteps(RUN),
    reply: wire.steps,
    command: 'automation_run_steps',
    args: { runId: RUN },
    method: 'GET',
    path: '/api/automation-runs/run%2F1/steps'
  },
  {
    name: 'markAutomationSeen',
    call: () => markAutomationSeen(ID),
    reply: null,
    command: 'automation_mark_seen',
    args: { id: ID },
    method: 'POST',
    path: '/api/automations/auto-1/seen',
    body: {}
  },
  {
    name: 'previewSchedule',
    call: () => previewSchedule({ kind: 'at', at: 5 }),
    reply: { next_runs: [5] },
    command: 'automation_preview_schedule',
    args: { schedule: { kind: 'at', at: 5 } },
    method: 'POST',
    path: '/api/automations/preview-schedule',
    body: { schedule: { kind: 'at', at: 5 } }
  },
  {
    name: 'listAutomationAgents',
    call: () => listAutomationAgents(),
    reply: [{ agent_id: 'claude', name: 'Claude' }],
    command: 'automation_list_agents',
    method: 'GET',
    path: '/api/automation-agents'
  },
  {
    name: 'listAutomationSecrets',
    call: () => listAutomationSecrets('p1'),
    reply: ['API_KEY'],
    command: 'automation_list_secrets',
    args: { projectId: 'p1' },
    method: 'GET',
    path: '/api/automation-secrets?project_id=p1'
  },
  {
    name: 'setAutomationSecret',
    call: () => setAutomationSecret('p1', 'API_KEY', 's3cret'),
    reply: null,
    command: 'automation_set_secret',
    args: { projectId: 'p1', name: 'API_KEY', value: 's3cret' },
    method: 'PUT',
    path: '/api/automation-secrets',
    body: { project_id: 'p1', name: 'API_KEY', value: 's3cret' }
  },
  {
    name: 'deleteAutomationSecret',
    call: () => deleteAutomationSecret('p1', 'API_KEY'),
    reply: null,
    command: 'automation_delete_secret',
    args: { projectId: 'p1', name: 'API_KEY' },
    method: 'DELETE',
    path: '/api/automation-secrets?project_id=p1&name=API_KEY'
  }
]

function ok(data: unknown) {
  return { success: true, data }
}

describe('automation facade transports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    vi.stubGlobal('window', { location: { origin: 'http://host' } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const c of CASES) {
    it(`${c.name} invokes ${c.command} on desktop`, async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockInvoke.mockResolvedValue(ok(c.reply))

      const result = (await c.call()) as { success: boolean }

      expect(result.success).toBe(true)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith(c.command, c.args)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it(`${c.name} sends ${c.method} ${c.path} on web`, async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ok(c.reply) })

      const result = (await c.call()) as { success: boolean }

      expect(result.success).toBe(true)
      expect(mockInvoke).not.toHaveBeenCalled()
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`http://host${c.path}`)
      expect(init.method).toBe(c.method)
      expect(init.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(c.body)
    })
  }

  it('parses the detail reply into the shared types', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValue(ok(detail))

    const result = await getAutomation(ID)

    expect(result).toEqual({ success: true, data: detail })
  })

  it('turns a reply of the wrong shape into INVALID_RESPONSE', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValue(ok([{ ...wire.automation, revision: 'two' }]))

    const result = await listAutomations('p1')

    expect(result).toEqual({
      success: false,
      error: 'automations[0].revision: expected a number',
      code: 'INVALID_RESPONSE'
    })
  })

  it('never logs a secret value', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValue(ok(null))

    await setAutomationSecret('p1', 'API_KEY', 'hunter2-value')

    const logged = JSON.stringify(mockLog.mock.calls)
    expect(logged).toContain('API_KEY')
    expect(logged).not.toContain('hunter2-value')
  })

  it('delivers well-formed change events and drops malformed ones', () => {
    const seen: unknown[] = []
    const stop = onAutomationChanged((change) => seen.push(change))

    publishAutomationChange({ project_id: 'p1', automation_id: 'auto-1' })
    publishAutomationChange({ project_id: 'p1', automation_id: null })
    publishAutomationChange({ project_id: 'p1' })
    publishAutomationChange({ project_id: 'p1', automation_id: 7 })
    stop()
    publishAutomationChange({ project_id: 'p2', automation_id: 'auto-2' })

    expect(seen).toEqual([
      { project_id: 'p1', automation_id: 'auto-1' },
      { project_id: 'p1', automation_id: null }
    ])
  })
})
