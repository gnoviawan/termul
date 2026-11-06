import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserShareView as view } from '@/lib/test-utils/browser-share'

const { api, logs } = vi.hoisted(() => ({
  api: {
    revoke: vi.fn(),
    list: vi.fn(),
    changed: [] as Array<(v: unknown) => void>,
    unlisten: vi.fn()
  },
  logs: [] as Array<{ level?: string; message: string }>
}))

vi.mock('@/lib/browser-share-api', () => ({
  browserShareRevoke: (id: string) => api.revoke(id),
  browserShareList: () => api.list(),
  onBrowserShareChanged: (cb: (v: unknown) => void) => {
    api.changed.push(cb)
    return api.unlisten
  }
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(async (p: { level?: string; message: string }) => {
    logs.push(p)
  })
}))

import {
  retainBrowserShareSync,
  selectSessionShares,
  selectTabActiveShares,
  useBrowserShareStore
} from './browser-share-store'

const store = () => useBrowserShareStore.getState()

beforeEach(() => {
  useBrowserShareStore.setState({
    shares: {},
    pending: {},
    ended: {},
    revoking: {},
    consentTabId: null
  })
  api.revoke.mockReset()
  api.list.mockReset().mockResolvedValue({ success: true, data: [] })
  api.changed.length = 0
  api.unlisten.mockReset()
  logs.length = 0
})

describe('upsert and ending', () => {
  it('keeps a pending share that ended so the composer can say why', () => {
    store().upsert(view(), { pending: true })
    store().upsert(view({ status: 'navigated' }))
    expect(store().shares['host-share-1']?.status).toBe('navigated')
    expect(selectTabActiveShares(store(), 'tab-1')).toEqual([])
  })

  it('drops a sent share once the host reports it ended', () => {
    store().upsert(view(), { pending: true })
    store().markSent(['host-share-1'])
    store().upsert(view({ status: 'closed' }))
    expect(store().shares).toEqual({})
  })

  it('ignores an ended share it never saw', () => {
    store().upsert(view({ status: 'expired' }))
    expect(store().shares).toEqual({})
  })

  it('markSent drops pending shares that already ended', () => {
    store().upsert(view(), { pending: true })
    store().upsert(view({ status: 'expired' }))
    store().markSent(['host-share-1'])
    expect(store().shares).toEqual({})
    expect(store().pending).toEqual({})
  })

  it('scopes selectors to session and tab', () => {
    store().upsert(view())
    store().upsert(view({ shareId: 'b', sessionId: 'sess-2', tabId: 'tab-2' }))
    expect(selectSessionShares(store(), 'sess-1').map((v) => v.shareId)).toEqual(['host-share-1'])
    expect(selectTabActiveShares(store(), 'tab-2').map((v) => v.shareId)).toEqual(['b'])
  })
})

describe('share identity and order', () => {
  it('an ended event before the create reply keeps the share ended and unsendable', () => {
    store().upsert(view())
    store().upsert(view({ status: 'navigated' }))
    store().upsert(view(), { pending: true })
    expect(store().shares['host-share-1']?.status).toBe('navigated')
    expect(selectTabActiveShares(store(), 'tab-1')).toEqual([])
  })

  it('an ended event that is the first word on a share beats the late create reply', () => {
    store().upsert(view({ status: 'closed' }))
    store().upsert(view(), { pending: true })
    expect(store().shares['host-share-1']?.status).toBe('closed')
    expect(selectTabActiveShares(store(), 'tab-1')).toEqual([])
  })

  it('an ending of one share leaves another share of the same tab and session alone', () => {
    store().upsert(view({ shareId: 'a' }))
    store().upsert(view({ shareId: 'b', status: 'revoked' }))
    store().upsert(view({ shareId: 'a' }), { pending: true })
    expect(store().shares.a?.status).toBe('active')
    expect(store().pending.a).toBe(true)
  })

  it('a share this renderer never sent is ready to share, never sent', () => {
    store().upsert(view({ shareId: 'listed' }))
    expect(store().pending.listed).toBe(true)
  })

  it('a sent share stays sent when the host reports it again', () => {
    store().upsert(view(), { pending: true })
    store().markSent(['host-share-1'])
    store().upsert(view())
    expect(store().pending).toEqual({})
    expect(store().shares['host-share-1']?.status).toBe('active')
  })

  it('a late host list does not bring back a share the user stopped', async () => {
    api.revoke.mockResolvedValue({ success: true, data: undefined })
    store().upsert(view(), { pending: true })
    await store().revoke('host-share-1')
    store().upsert(view())
    expect(store().shares).toEqual({})
  })
})

describe('revoke', () => {
  it('removes the share only after the host confirms', async () => {
    let resolve: (v: unknown) => void = () => {}
    api.revoke.mockReturnValue(new Promise((r) => (resolve = r)))
    store().upsert(view())
    const pending = store().revoke('host-share-1')
    expect(store().revoking['host-share-1']).toBe(true)
    expect(store().shares['host-share-1']).toBeDefined()
    resolve({ success: true, data: undefined })
    expect(await pending).toBe(true)
    expect(store().shares).toEqual({})
    expect(store().revoking).toEqual({})
  })

  it('treats NOT_FOUND as already gone', async () => {
    api.revoke.mockResolvedValue({ success: false, code: 'NOT_FOUND' })
    store().upsert(view())
    expect(await store().revoke('host-share-1')).toBe(true)
    expect(store().shares).toEqual({})
  })

  it('keeps the share visible when the host refuses, and logs only the code', async () => {
    api.revoke.mockResolvedValue({ success: false, code: 'FAILED' })
    store().upsert(view())
    expect(await store().revoke('host-share-1')).toBe(false)
    expect(store().shares['host-share-1']).toBeDefined()
    expect(store().revoking).toEqual({})
    const text = JSON.stringify(logs)
    expect(text).toContain('code=FAILED')
    expect(text).not.toContain('host-share-1')
    expect(text).not.toContain('example.com')
  })

  it('dismisses an ended pending share without calling the host', async () => {
    store().upsert(view(), { pending: true })
    store().upsert(view({ status: 'navigated' }))
    expect(await store().revoke('host-share-1')).toBe(true)
    expect(api.revoke).not.toHaveBeenCalled()
    expect(store().shares).toEqual({})
  })
})

describe('retainBrowserShareSync', () => {
  it('subscribes once, rehydrates from the host list, and releases on last release', async () => {
    api.list.mockResolvedValue({ success: true, data: [view({ shareId: 'listed' })] })
    const a = retainBrowserShareSync()
    const b = retainBrowserShareSync()
    expect(api.changed).toHaveLength(1)
    await vi.waitFor(() => expect(store().shares.listed).toBeDefined())
    expect(store().pending.listed).toBe(true)
    api.changed[0](view({ shareId: 'evt' }))
    expect(store().shares.evt).toBeDefined()
    a()
    a()
    expect(api.unlisten).not.toHaveBeenCalled()
    b()
    expect(api.unlisten).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the host has no share commands yet', async () => {
    api.list.mockResolvedValue({ success: false, code: 'UNAVAILABLE' })
    const release = retainBrowserShareSync()
    await Promise.resolve()
    await Promise.resolve()
    expect(logs).toEqual([])
    release()
  })
})
