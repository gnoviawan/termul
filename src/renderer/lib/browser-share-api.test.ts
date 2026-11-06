import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runtime, listeners } = vi.hoisted(() => ({
  runtime: { tauri: true },
  listeners: [] as Array<(event: { payload: unknown }) => void>
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.push(cb)
    return () => {}
  })
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => runtime.tauri }))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { browserShareView as shareView } from '@/lib/test-utils/browser-share'
import {
  browserShareBlock,
  browserShareCreate,
  browserShareList,
  browserShareOriginOf,
  browserShareRevoke,
  isBrowserShareView,
  onBrowserShareChanged
} from './browser-share-api'

const REQUEST = {
  tabId: 'tab-1',
  sessionId: 'sess-1',
  scopes: ['content' as const],
  expectedOrigin: 'https://app.example.com'
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  vi.mocked(listen).mockClear()
  listeners.length = 0
  runtime.tauri = true
})

describe('browserShareCreate', () => {
  it('passes the tab, session, scopes and expected origin to the host', async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, data: shareView() })
    const result = await browserShareCreate(REQUEST)
    expect(invoke).toHaveBeenCalledWith('browser_share_create', REQUEST)
    expect(result).toEqual({ success: true, data: shareView({ expiresAtMs: expect.any(Number) }) })
  })

  it('keeps the host code and drops the host message', async () => {
    vi.mocked(invoke).mockResolvedValue({
      success: false,
      code: 'ORIGIN_CHANGED',
      error: 'tab is now on https://evil.example/?token=secret'
    })
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code: 'ORIGIN_CHANGED' })
  })

  it('maps a missing host command to UNAVAILABLE', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('command browser_share_create not found'))
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code: 'UNAVAILABLE' })
  })

  it.each([
    'SCOPE_UNAVAILABLE',
    'ORIGIN_NOT_SHAREABLE',
    'SHARE_LIMIT'
  ])('keeps the host refusal %s', async (code) => {
    vi.mocked(invoke).mockResolvedValue({ success: false, code, error: 'x' })
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code })
  })

  it('maps an unknown host code to FAILED', async () => {
    vi.mocked(invoke).mockResolvedValue({ success: false, code: 'WHATEVER', error: 'x' })
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code: 'FAILED' })
  })

  it('refuses a malformed host reply instead of showing it', async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, data: { shareId: 'x' } })
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code: 'INVALID_RESPONSE' })
  })

  it.each([
    undefined,
    null,
    'ok',
    { data: {} }
  ])('treats host reply %j as INVALID_RESPONSE', async (reply) => {
    vi.mocked(invoke).mockResolvedValue(reply)
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code: 'INVALID_RESPONSE' })
    expect(await browserShareRevoke('x')).toEqual({ success: false, code: 'INVALID_RESPONSE' })
    expect(await browserShareList()).toEqual({ success: false, code: 'INVALID_RESPONSE' })
  })

  it('does not call the host outside the desktop app', async () => {
    runtime.tauri = false
    expect(await browserShareCreate(REQUEST)).toEqual({ success: false, code: 'UNSUPPORTED' })
    expect(await browserShareRevoke('host-share-1')).toEqual({
      success: false,
      code: 'UNSUPPORTED'
    })
    expect(await browserShareList()).toEqual({ success: false, code: 'UNSUPPORTED' })
    expect(onBrowserShareChanged(() => {})).toBeTypeOf('function')
    expect(invoke).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  })
})

describe('browserShareRevoke / browserShareList', () => {
  it('revokes by host share id', async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, data: undefined })
    expect(await browserShareRevoke('host-share-1')).toEqual({ success: true, data: undefined })
    expect(invoke).toHaveBeenCalledWith('browser_share_revoke', { shareId: 'host-share-1' })
  })

  it('reports NOT_FOUND for an already ended share', async () => {
    vi.mocked(invoke).mockResolvedValue({ success: false, code: 'NOT_FOUND', error: '' })
    expect(await browserShareRevoke('gone')).toEqual({ success: false, code: 'NOT_FOUND' })
  })

  it('lists only well-formed shares', async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, data: [shareView(), { bad: true }] })
    const result = await browserShareList()
    expect(result.success && result.data.map((v) => v.shareId)).toEqual(['host-share-1'])
  })
})

describe('isBrowserShareView', () => {
  it.each([
    ['unknown scope', { scopes: ['cookies'] }],
    ['no scope', { scopes: [] }],
    ['unknown status', { status: 'paused' }],
    ['empty share id', { shareId: '' }],
    ['missing reference', { reference: null }],
    ['empty reference uri', { reference: { uri: '', name: 'x' } }],
    ['non-finite expiry', { expiresAtMs: Number.NaN }]
  ])('rejects %s', (_label, overrides) => {
    expect(isBrowserShareView({ ...shareView(), ...overrides })).toBe(false)
  })
})

describe('onBrowserShareChanged', () => {
  it('forwards valid payloads and drops malformed ones', async () => {
    const cb = vi.fn()
    onBrowserShareChanged(cb)
    await Promise.resolve()
    expect(listen).toHaveBeenCalledWith('browser_share_changed', expect.any(Function))
    listeners[0]({ payload: { shareId: 'x' } })
    listeners[0]({ payload: shareView({ status: 'navigated' }) })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].status).toBe('navigated')
  })
})

describe('helpers', () => {
  it('forwards the host reference as a resource_link block only', () => {
    expect(browserShareBlock(shareView())).toEqual({
      type: 'resource_link',
      uri: 'termul-browser-share://host-share-1',
      name: 'Browser page'
    })
  })

  it('derives the expected origin without path, query or credentials', () => {
    expect(browserShareOriginOf('https://u:p@app.example.com:8443/a?token=1#x')).toBe(
      'https://app.example.com:8443'
    )
    expect(browserShareOriginOf('about:blank')).toBeNull()
    expect(browserShareOriginOf('file:///etc/passwd')).toBeNull()
    expect(browserShareOriginOf('not a url')).toBeNull()
  })
})
