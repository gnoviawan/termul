/**
 * The browser host seam: a registered host (the GPUIX client) gets every
 * browser-api call and event subscription, and turns on the browser-pane
 * entry points and webview occlusion; with no host the browser keeps its
 * web behavior and Tauri keeps its `invoke` commands.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke, mockListen, tauriRef } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  tauriRef: { current: false }
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mockListen }))
vi.mock('../tauri-runtime', () => ({ isTauriContext: () => tauriRef.current }))

import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded,
  useNativeWebviewOcclusion
} from '@/hooks/use-native-webview-occlusion'
import {
  browserTabCreate,
  browserTabDestroy,
  browserTabGoBack,
  browserTabGoForward,
  browserTabHide,
  browserTabInjectAgentation,
  browserTabNavigate,
  browserTabOpenDevtools,
  browserTabReload,
  browserTabResize,
  browserTabShow,
  onBrowserTabLoaded,
  onBrowserTabNavigated,
  onBrowserTabTitleChanged
} from '../browser-api'
import { _resetBrowserHostForTesting, type BrowserHost, registerBrowserHost } from '../browser-host'
import { nativeBrowserPanesAvailable } from '../browser-panes'

const BOUNDS = { x: 10, y: 20, width: 300, height: 200 }

function recordingHost(): {
  host: BrowserHost
  calls: string[]
  emit: Record<string, (p: unknown) => void>
} {
  const calls: string[] = []
  const emit: Record<string, (p: unknown) => void> = {}
  const done =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`)
      return { success: true as const, data: undefined }
    }
  const subscribe = (name: string) => (callback: (p: never) => void) => {
    emit[name] = callback as (p: unknown) => void
    return { unlisten: () => calls.push(`unlisten ${name}`) }
  }
  return {
    calls,
    emit,
    host: {
      create: async (tabId, url, bounds) => {
        calls.push(
          `create(${JSON.stringify(tabId)}, ${JSON.stringify(url)}, ${JSON.stringify(bounds)})`
        )
        return { success: true, data: { id: tabId, url, title: '', agentControlled: false } }
      },
      navigate: done('navigate'),
      resize: done('resize'),
      show: done('show'),
      hide: done('hide'),
      destroy: done('destroy'),
      goBack: done('goBack'),
      goForward: done('goForward'),
      reload: done('reload'),
      openDevtools: done('openDevtools'),
      injectAgentation: async () => ({ success: false, error: 'not here', code: 'NOT_SUPPORTED' }),
      onNavigated: subscribe('navigated'),
      onLoaded: subscribe('loaded'),
      onTitleChanged: subscribe('title')
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tauriRef.current = false
  _resetBrowserHostForTesting()
  resetNativeWebviewOcclusionForTests()
})

afterEach(() => {
  resetNativeWebviewOcclusionForTests()
})

describe('browser-api with a registered browser host', () => {
  it('routes every command to the host and never invokes Tauri', async () => {
    const { host, calls } = recordingHost()
    registerBrowserHost(host)

    expect(await browserTabCreate('t1', 'http://127.0.0.1:9/', BOUNDS)).toEqual({
      success: true,
      data: { id: 't1', url: 'http://127.0.0.1:9/', title: '', agentControlled: false }
    })
    await browserTabNavigate('t1', 'http://127.0.0.1:9/b')
    await browserTabResize('t1', BOUNDS)
    await browserTabShow('t1')
    await browserTabHide('t1')
    await browserTabGoBack('t1')
    await browserTabGoForward('t1')
    await browserTabReload('t1')
    await browserTabOpenDevtools('t1')
    await browserTabDestroy('t1')
    expect(await browserTabInjectAgentation('t1')).toEqual({
      success: false,
      error: 'not here',
      code: 'NOT_SUPPORTED'
    })

    expect(calls).toEqual([
      'create("t1", "http://127.0.0.1:9/", {"x":10,"y":20,"width":300,"height":200})',
      'navigate("t1", "http://127.0.0.1:9/b")',
      'resize("t1", {"x":10,"y":20,"width":300,"height":200})',
      'show("t1")',
      'hide("t1")',
      'goBack("t1")',
      'goForward("t1")',
      'reload("t1")',
      'openDevtools("t1")',
      'destroy("t1")'
    ])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('delivers host events to the facade subscribers', () => {
    const { host, emit, calls } = recordingHost()
    registerBrowserHost(host)
    const seen: unknown[] = []
    const subs = [
      onBrowserTabNavigated((p) => seen.push(['navigated', p])),
      onBrowserTabLoaded((p) => seen.push(['loaded', p])),
      onBrowserTabTitleChanged((p) => seen.push(['title', p]))
    ]

    emit.navigated({ browserTabId: 't1', url: 'http://127.0.0.1:9/b' })
    emit.loaded({ browserTabId: 't1' })
    emit.title({ browserTabId: 't1', title: 'Page B' })
    for (const sub of subs) sub.unlisten()

    expect(seen).toEqual([
      ['navigated', { browserTabId: 't1', url: 'http://127.0.0.1:9/b' }],
      ['loaded', { browserTabId: 't1' }],
      ['title', { browserTabId: 't1', title: 'Page B' }]
    ])
    expect(calls).toEqual(['unlisten navigated', 'unlisten loaded', 'unlisten title'])
    expect(mockListen).not.toHaveBeenCalled()
  })

  it('turns on the browser-pane entry points and webview occlusion', () => {
    expect(nativeBrowserPanesAvailable()).toBe(false)
    registerBrowserHost(recordingHost().host)
    expect(nativeBrowserPanesAvailable()).toBe(true)

    const observer = renderHook(() => useNativeWebviewOccluded())
    const occluder = renderHook(({ open }) => useNativeWebviewOcclusion(open), {
      initialProps: { open: false }
    })
    act(() => occluder.rerender({ open: true }))
    expect(observer.result.current).toBe(true)
    act(() => occluder.rerender({ open: false }))
    expect(observer.result.current).toBe(false)
  })
})

describe('browser-api with no browser host', () => {
  it('the browser client has no browser panes and no occlusion', () => {
    expect(nativeBrowserPanesAvailable()).toBe(false)
    const observer = renderHook(() => useNativeWebviewOccluded())
    renderHook(() => useNativeWebviewOcclusion(true))
    expect(observer.result.current).toBe(false)
  })

  it('Tauri keeps its invoke commands', async () => {
    tauriRef.current = true
    mockInvoke.mockResolvedValue({ success: true, data: undefined })
    expect(nativeBrowserPanesAvailable()).toBe(true)

    await browserTabNavigate('t1', 'https://termul.dev/')
    await browserTabResize('t1', BOUNDS)
    await browserTabDestroy('t1')

    expect(mockInvoke.mock.calls).toEqual([
      ['browser_tab_navigate', { tabId: 't1', url: 'https://termul.dev/' }],
      ['browser_tab_resize', { tabId: 't1', bounds: BOUNDS }],
      ['browser_tab_destroy', { tabId: 't1' }]
    ])
  })
})
