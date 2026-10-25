/**
 * Browser policy facade tests. One in-memory fake host answers both
 * transports: the desktop path through `invoke`, the web path through
 * `fetch`. The same operation sequence must produce the same results either
 * way, and a stale revision must be retried on fresh state.
 */

import type { ProjectBrowserPolicy } from '@shared/types/browser-policy.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext, mockInvoke } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('../log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import {
  browserPolicyApi,
  browserPolicyFailure,
  editAppBrowserPolicy,
  editProjectBrowserPolicy,
  onBrowserPolicyChanged,
  publishBrowserPolicyChange
} from '../browser-policy-api'
import {
  type BrowserPolicyHost,
  createBrowserPolicyHost,
  DESKTOP_COMMANDS
} from '../test-utils/browser-policy-host'

function seeded(host: BrowserPolicyHost, projectId: string): ProjectBrowserPolicy {
  host.dispatch('get_project', { projectId })
  return host.projects.get(projectId) as ProjectBrowserPolicy
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) } as Response
}

function wire(host: BrowserPolicyHost): void {
  mockInvoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    host.dispatch(DESKTOP_COMMANDS[command], args)
  )
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (init?.method === 'POST') {
      return jsonResponse(
        host.dispatch(path.endsWith('/project') ? 'apply_project' : 'apply_app', body)
      )
    }
    if (path.startsWith('/host/browser-policy/project')) {
      const projectId = new URL(url, 'http://host').searchParams.get('projectId')
      return jsonResponse(host.dispatch('get_project', { projectId }))
    }
    return jsonResponse(host.dispatch('get_app', {}))
  })
}

describe('browserPolicyApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('desktop: invokes the browser_policy_* commands with camelCase arguments', async () => {
    mockIsTauriContext.mockReturnValue(true)
    const host = createBrowserPolicyHost()
    wire(host)

    await browserPolicyApi.getProject('p1')
    await browserPolicyApi.getApp()
    await browserPolicyApi.applyProject('p1', 0, { op: 'add_origin', origin: 'https://a.example' })
    await browserPolicyApi.applyApp(0, { op: 'set_global_profile', enabled: false })

    expect(mockInvoke.mock.calls).toEqual([
      ['browser_policy_get_project', { projectId: 'p1' }],
      ['browser_policy_get_app', undefined],
      [
        'browser_policy_apply_project',
        {
          projectId: 'p1',
          expectedRevision: 0,
          op: { op: 'add_origin', origin: 'https://a.example' }
        }
      ],
      [
        'browser_policy_apply_app',
        { expectedRevision: 0, op: { op: 'set_global_profile', enabled: false } }
      ]
    ])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('web: calls the /host/browser-policy routes and never invoke', async () => {
    mockIsTauriContext.mockReturnValue(false)
    wire(createBrowserPolicyHost())

    await browserPolicyApi.getProject('p 1')
    await browserPolicyApi.applyProject('p1', 0, { op: 'set_ephemeral', ephemeral: true })
    await browserPolicyApi.applyApp(0, { op: 'set_global_profile', enabled: false })

    const calls = mockFetch.mock.calls.map(([url, init]) => [
      String(url).replace(/^https?:\/\/[^/]+/, ''),
      (init as RequestInit).method,
      (init as RequestInit).body
    ])
    expect(calls).toEqual([
      ['/host/browser-policy/project?projectId=p%201', 'GET', undefined],
      [
        '/host/browser-policy/project',
        'POST',
        JSON.stringify({
          projectId: 'p1',
          expectedRevision: 0,
          op: { op: 'set_ephemeral', ephemeral: true }
        })
      ],
      [
        '/host/browser-policy/app',
        'POST',
        JSON.stringify({ expectedRevision: 0, op: { op: 'set_global_profile', enabled: false } })
      ]
    ])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('returns the same results on both transports for the same operation sequence', async () => {
    const sequence = async (): Promise<IpcResult<unknown>[]> => {
      const out: IpcResult<unknown>[] = []
      out.push(await browserPolicyApi.getApp())
      out.push(
        await browserPolicyApi.applyProject('p1', 0, {
          op: 'add_origin',
          origin: 'https://a.example'
        })
      )
      out.push(
        await browserPolicyApi.applyProject('p1', 0, {
          op: 'add_origin',
          origin: 'https://b.example'
        })
      )
      out.push(
        await browserPolicyApi.applyProject('p1', 1, {
          op: 'add_origin',
          origin: 'http://tauri.localhost'
        })
      )
      out.push(
        await browserPolicyApi.applyProject('p1', 1, { op: 'set_ephemeral', ephemeral: true })
      )
      out.push(await browserPolicyApi.applyApp(0, { op: 'clear_global_profile' }))
      out.push(await browserPolicyApi.applyApp(0, { op: 'set_global_profile', enabled: false }))
      out.push(await browserPolicyApi.getProject('p1'))
      return out
    }

    mockIsTauriContext.mockReturnValue(true)
    wire(createBrowserPolicyHost())
    const desktop = await sequence()

    mockIsTauriContext.mockReturnValue(false)
    wire(createBrowserPolicyHost())
    const web = await sequence()

    expect(web).toEqual(desktop)
    expect(desktop.filter((r) => r.success)).toHaveLength(5)
  })
})

describe('edit helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockIsTauriContext.mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reloads and retries a stale revision so a concurrent edit is kept', async () => {
    const host = createBrowserPolicyHost()
    wire(host)
    const known = (await browserPolicyApi.getProject('p1')) as {
      success: true
      data: ProjectBrowserPolicy
    }
    host.beforeNextApply = () => {
      const policy = seeded(host, 'p1')
      policy.allowList.push('https://other-surface.example')
      policy.revision += 1
    }

    const result = await editProjectBrowserPolicy(
      'p1',
      { op: 'add_origin', origin: 'https://mine.example' },
      known.data
    )

    expect(result.success).toBe(true)
    expect(seeded(host, 'p1').allowList).toEqual([
      'https://other-surface.example',
      'https://mine.example'
    ])
    expect(host.applyCalls).toBe(2)
  })

  it('reads the current revision first when the caller has none', async () => {
    const host = createBrowserPolicyHost()
    seeded(host, 'p1').revision = 7
    wire(host)
    const result = await editProjectBrowserPolicy('p1', { op: 'set_ephemeral', ephemeral: true })
    expect(result.success).toBe(true)
    expect(host.applyCalls).toBe(1)
  })

  it('gives up with revision_conflict when the policy never settles', async () => {
    const host = createBrowserPolicyHost()
    wire(host)
    mockInvoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === 'browser_policy_apply_project') {
        host.applyCalls += 1
        return {
          success: false,
          error: 'revision_conflict: the policy changed',
          code: 'invalid_params'
        }
      }
      return host.dispatch(DESKTOP_COMMANDS[command], args)
    })

    const result = await editProjectBrowserPolicy('p1', { op: 'set_ephemeral', ephemeral: true })

    expect(result.success).toBe(false)
    expect(!result.success && browserPolicyFailure(result).reason).toBe('revision_conflict')
    expect(host.applyCalls).toBe(5)
  })

  it('does not retry a refusal that is not a conflict', async () => {
    const host = createBrowserPolicyHost()
    wire(host)
    const result = await editProjectBrowserPolicy('p1', {
      op: 'add_origin',
      origin: 'http://tauri.localhost'
    })
    expect(result.success).toBe(false)
    expect(!result.success && browserPolicyFailure(result)).toEqual({
      code: 'invalid_params',
      reason: 'reserved_origin',
      message: "termul's own app origins cannot be allow-listed"
    })
    expect(host.applyCalls).toBe(1)
  })

  it('edits the app policy the same way', async () => {
    const host = createBrowserPolicyHost()
    wire(host)
    const off = await editAppBrowserPolicy({ op: 'set_global_profile', enabled: false })
    expect(off.success && off.data.globalProfileEnabled).toBe(false)
    const clear = await editAppBrowserPolicy({ op: 'clear_global_profile' })
    expect(!clear.success && browserPolicyFailure(clear)).toMatchObject({
      code: 'capability_unavailable',
      reason: 'profile_engine_unavailable'
    })
  })
})

describe('browserPolicyFailure', () => {
  it('splits a policy refusal into code, reason and message', () => {
    expect(
      browserPolicyFailure({
        success: false,
        code: 'invalid_params',
        error: 'app_scope_required: app-level browser policy needs a client with app scope'
      })
    ).toEqual({
      code: 'invalid_params',
      reason: 'app_scope_required',
      message: 'app-level browser policy needs a client with app scope'
    })
  })

  it('leaves transport and auth failures without a reason', () => {
    expect(
      browserPolicyFailure({
        success: false,
        code: 'NETWORK_ERROR',
        error: 'HTTP 502: bad gateway'
      })
    ).toEqual({ code: 'NETWORK_ERROR', reason: null, message: 'HTTP 502: bad gateway' })
    expect(
      browserPolicyFailure({ success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' })
    ).toEqual({ code: 'UNAUTHORIZED', reason: null, message: 'Unauthorized' })
  })
})

describe('browser_policy_changed events', () => {
  it('reaches subscribers until they unsubscribe and drops malformed payloads', () => {
    const seen: unknown[] = []
    const stop = onBrowserPolicyChanged((change) => seen.push(change))

    publishBrowserPolicyChange({ scope: 'app', revision: 2 })
    publishBrowserPolicyChange({ scope: 'project', projectId: 'p1', revision: 5 })
    publishBrowserPolicyChange({ scope: 'project', revision: 5 })
    publishBrowserPolicyChange({ scope: 'galaxy', revision: 1 })
    publishBrowserPolicyChange(null)
    stop()
    publishBrowserPolicyChange({ scope: 'app', revision: 3 })

    expect(seen).toEqual([
      { scope: 'app', revision: 2 },
      { scope: 'project', projectId: 'p1', revision: 5 }
    ])
  })
})
