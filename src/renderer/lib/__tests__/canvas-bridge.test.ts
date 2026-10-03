/**
 * Canvas bridge tests (OpenPencil canvas mode, task 22 + review round).
 *
 * Pins the `op_editor_core::bridge_protocol` wire contract verbatim: the
 * codec builders/events round-trip with the exact `op-bridge/*` /
 * `op-shell/*` type strings and camelCase fields, the postMessage adapter
 * enforces the source + origin lock (an unparseable origin locks the bridge
 * entirely), the init retry loop follows the 500ms / 20 /
 * reset-on-`listening` cadence and reports `onInitFailed` when the budget is
 * exhausted, and the `op-shell/save` / `op-shell/copy` control messages
 * reach their callbacks (while business payloads embedding "op-shell/" text
 * are never misclassified, and `op-shell/open-external` is ignored).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logFrontendError } from '@/lib/log-api'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import {
  BRIDGE_EDITOR_MESSAGES,
  BRIDGE_HOST_MESSAGES,
  BRIDGE_INIT_MAX_TRIES,
  BRIDGE_INIT_RETRY_MS,
  buildInitMessage,
  buildLocaleMessage,
  buildResolveConflictMessage,
  buildSaveCommittedMessage,
  buildSnapshotMessage,
  buildThemeMessage,
  type CanvasBridgeEvent,
  createCanvasBridge,
  isShellSaveRequest,
  originOfEmbedUrl,
  parseBridgeEvent,
  parseShellCopyText,
  SHELL_CONTROL_MESSAGES,
  toSupportedBridgeLocale
} from '../canvas-bridge'

const IFRAME_ORIGIN = 'http://127.0.0.1:5199'

interface FakeIframe {
  element: HTMLIFrameElement
  postMessage: ReturnType<typeof vi.fn>
}

function fakeIframe(): FakeIframe {
  const postMessage = vi.fn()
  const contentWindow = { postMessage } as unknown as Window
  const element = { contentWindow } as unknown as HTMLIFrameElement
  return { element, postMessage }
}

function dispatchFromIframe(
  iframe: FakeIframe,
  data: string,
  origin: string = IFRAME_ORIGIN
): void {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'origin', { value: origin })
  Object.defineProperty(event, 'source', { value: iframe.element.contentWindow })
  window.dispatchEvent(event)
}

function parsePosted(raw: unknown): Record<string, unknown> {
  return JSON.parse(raw as string) as Record<string, unknown>
}

describe('canvas-bridge codec (host → editor builders)', () => {
  it('builds every host message with the verbatim op-bridge/* type string', () => {
    expect(parsePosted(buildInitMessage('t0k')).type).toBe(BRIDGE_HOST_MESSAGES.INIT)
    expect(parsePosted(buildThemeMessage('dark')).type).toBe(BRIDGE_HOST_MESSAGES.THEME)
    expect(parsePosted(buildLocaleMessage('en-US')).type).toBe(BRIDGE_HOST_MESSAGES.LOCALE)
    expect(parsePosted(buildSaveCommittedMessage(3, 41)).type).toBe(
      BRIDGE_HOST_MESSAGES.SAVE_COMMITTED
    )
    expect(parsePosted(buildResolveConflictMessage('use-local', 'r1')).type).toBe(
      BRIDGE_HOST_MESSAGES.RESOLVE_CONFLICT
    )
    expect(parsePosted(buildSnapshotMessage('save', 'r2')).type).toBe(BRIDGE_HOST_MESSAGES.SNAPSHOT)
  })

  it('init carries token + optional mcpUrl with camelCase field names', () => {
    expect(parsePosted(buildInitMessage('t0k'))).toEqual({
      type: 'op-bridge/init',
      token: 't0k'
    })
    expect(parsePosted(buildInitMessage('t0k', 'http://127.0.0.1:9/canvas/mcp'))).toEqual({
      type: 'op-bridge/init',
      token: 't0k',
      mcpUrl: 'http://127.0.0.1:9/canvas/mcp'
    })
  })

  it('theme / locale / save-committed / resolve-conflict payload shapes are exact', () => {
    expect(parsePosted(buildThemeMessage('light'))).toEqual({
      type: 'op-bridge/theme',
      colorScheme: 'light'
    })
    expect(parsePosted(buildLocaleMessage('zh-CN'))).toEqual({
      type: 'op-bridge/locale',
      locale: 'zh-CN'
    })
    expect(parsePosted(buildSaveCommittedMessage(3, 41))).toEqual({
      type: 'op-bridge/save-committed',
      generation: 3,
      revision: 41
    })
    expect(parsePosted(buildResolveConflictMessage('accept-remote', 'r1'))).toEqual({
      type: 'op-bridge/resolve-conflict',
      mode: 'accept-remote',
      requestId: 'r1'
    })
  })
})

describe('canvas-bridge codec (editor → host event parsing)', () => {
  it('parses every editor event with the verbatim type string and camelCase fields', () => {
    expect(parseBridgeEvent('{"type":"op-bridge/listening"}')).toEqual({ type: 'listening' })
    expect(parseBridgeEvent('{"type":"op-bridge/ready","generation":2,"revision":17}')).toEqual({
      type: 'ready',
      generation: 2,
      revision: 17
    })
    expect(
      parseBridgeEvent(
        '{"type":"op-bridge/dirty-changed","generation":3,"revision":18,"dirty":true}'
      )
    ).toEqual({ type: 'dirty-changed', generation: 3, revision: 18, dirty: true })
    expect(
      parseBridgeEvent(
        '{"type":"op-bridge/sync-conflict","generation":3,"revision":18,"serverVersion":19}'
      )
    ).toEqual({ type: 'sync-conflict', generation: 3, revision: 18, serverVersion: 19 })
    expect(parseBridgeEvent('{"type":"op-bridge/conflict-resolved","requestId":"r1"}')).toEqual({
      type: 'conflict-resolved',
      requestId: 'r1'
    })
  })

  it('foreign postMessage traffic is ignored, never an error', () => {
    expect(parseBridgeEvent('{"type":"react-devtools"}')).toBeNull()
    expect(parseBridgeEvent('not json at all')).toBeNull()
    expect(parseBridgeEvent({ type: 'op-bridge/ready' })).toBeNull()
    expect(parseBridgeEvent(null)).toBeNull()
    // Malformed bridge events (missing/typed fields) are dropped too.
    expect(parseBridgeEvent('{"type":"op-bridge/ready","generation":"2","revision":17}')).toBeNull()
    expect(
      parseBridgeEvent('{"type":"op-bridge/dirty-changed","generation":3,"revision":18}')
    ).toBeNull()
  })
})

describe('canvas-bridge shell control classification', () => {
  it('op-shell/save and op-shell/copy are recognized by their top-level type', () => {
    expect(isShellSaveRequest('{"type":"op-shell/save"}')).toBe(true)
    expect(isShellSaveRequest('{"type":"op-bridge/ready","generation":0,"revision":0}')).toBe(false)
    expect(parseShellCopyText('{"type":"op-shell/copy","text":"copied!"}')).toBe('copied!')
    expect(parseShellCopyText('{"type":"op-shell/copy","text":42}')).toBeUndefined()
    expect(parseShellCopyText('{"type":"op-shell/save"}')).toBeUndefined()
  })

  it('a business payload embedding op-shell/ text is never misclassified', () => {
    const snapshot = JSON.stringify({
      type: 'op-bridge/snapshot-result',
      requestId: 'r1',
      docJson: '{"note":"mentions op-shell/save inline"}',
      generation: 1,
      revision: 1
    })
    expect(isShellSaveRequest(snapshot)).toBe(false)
    expect(parseShellCopyText(snapshot)).toBeUndefined()
    expect(parseBridgeEvent(snapshot)?.type).toBe('snapshot-result')
  })
})

describe('canvas-bridge helpers', () => {
  it('originOfEmbedUrl resolves absolute loopback and relative web embed URLs', () => {
    expect(originOfEmbedUrl('http://127.0.0.1:5199/?embed=vscode')).toBe('http://127.0.0.1:5199')
    expect(originOfEmbedUrl('/canvas/cv0/?embed=vscode&ct=abc')).toBe(window.location.origin)
  })

  it('toSupportedBridgeLocale maps the host locale onto the codec-accepted set', () => {
    expect(toSupportedBridgeLocale('zh')).toBe('zh-CN')
    expect(toSupportedBridgeLocale('zh-TW')).toBe('zh-CN')
    expect(toSupportedBridgeLocale('en-GB')).toBe('en-US')
    expect(toSupportedBridgeLocale('fr')).toBe('en-US')
  })
})

describe('canvas-bridge postMessage adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createBridge(iframe: FakeIframe, onEvent: (event: CanvasBridgeEvent) => void = vi.fn()) {
    return createCanvasBridge({
      iframe: iframe.element,
      iframeOrigin: IFRAME_ORIGIN,
      token: 't0k',
      mcpUrl: 'http://127.0.0.1:9/canvas/mcp',
      onEvent,
      onShellSave: vi.fn(),
      onShellCopy: vi.fn()
    })
  }

  it('posts init immediately with the token + mcpUrl and the iframe origin as targetOrigin', () => {
    const iframe = fakeIframe()
    const bridge = createBridge(iframe)
    expect(iframe.postMessage).toHaveBeenCalledTimes(1)
    const [json, targetOrigin] = iframe.postMessage.mock.calls[0] as [string, string]
    expect(parsePosted(json)).toEqual({
      type: 'op-bridge/init',
      token: 't0k',
      mcpUrl: 'http://127.0.0.1:9/canvas/mcp'
    })
    expect(targetOrigin).toBe(IFRAME_ORIGIN)
    bridge.dispose()
  })

  it('retries init every 500ms and stops after the 20-try cap', () => {
    const iframe = fakeIframe()
    const bridge = createBridge(iframe)
    expect(iframe.postMessage).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS)
    expect(iframe.postMessage).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * (BRIDGE_INIT_MAX_TRIES + 5))
    expect(iframe.postMessage).toHaveBeenCalledTimes(BRIDGE_INIT_MAX_TRIES)
    bridge.dispose()
  })

  it('reports onInitFailed (once) when the retry budget is exhausted without listening/ready', () => {
    const iframe = fakeIframe()
    const onInitFailed = vi.fn()
    const bridge = createCanvasBridge({
      iframe: iframe.element,
      iframeOrigin: IFRAME_ORIGIN,
      token: 't0k',
      onEvent: vi.fn(),
      onShellSave: vi.fn(),
      onShellCopy: vi.fn(),
      onInitFailed
    })
    expect(onInitFailed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * (BRIDGE_INIT_MAX_TRIES + 5))
    expect(onInitFailed).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'canvas-bridge.init', level: 'warn' })
    )
    // Latched: a second exhaustion window does not re-report.
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * (BRIDGE_INIT_MAX_TRIES + 5))
    expect(onInitFailed).toHaveBeenCalledTimes(1)
    bridge.dispose()
  })

  it('an unparseable origin locks the bridge: no init post, every inbound message is foreign', () => {
    const iframe = fakeIframe()
    const onEvent = vi.fn()
    const onShellSave = vi.fn()
    const bridge = createCanvasBridge({
      iframe: iframe.element,
      iframeOrigin: '',
      token: 't0k',
      onEvent,
      onShellSave,
      onShellCopy: vi.fn()
    })

    // No outbound post (an empty targetOrigin would throw) and a one-time
    // origin-lock log.
    expect(iframe.postMessage).not.toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'canvas-bridge.origin', level: 'warn' })
    )

    // Even a message carrying the empty origin (and the right source) is
    // foreign — nothing may pass without a valid origin check.
    const event = new MessageEvent('message', { data: '{"type":"op-shell/save"}' })
    Object.defineProperty(event, 'origin', { value: '' })
    Object.defineProperty(event, 'source', { value: iframe.element.contentWindow })
    window.dispatchEvent(event)
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * 30)
    expect(onEvent).not.toHaveBeenCalled()
    expect(onShellSave).not.toHaveBeenCalled()
    expect(iframe.postMessage).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('op-shell/open-external is ignored with a single info log (URL never logged)', () => {
    const iframe = fakeIframe()
    const onEvent = vi.fn()
    const bridge = createBridge(iframe, onEvent)
    vi.mocked(logFrontendError).mockClear()

    dispatchFromIframe(iframe, '{"type":"op-shell/open-external","url":"https://auth.example/x"}')
    dispatchFromIframe(iframe, '{"type":"op-shell/open-external","url":"https://auth.example/y"}')

    expect(onEvent).not.toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'canvas-bridge.shell', level: 'info' })
    )
    const logged = JSON.stringify(vi.mocked(logFrontendError).mock.calls[0])
    expect(logged).not.toContain('auth.example')
    bridge.dispose()
  })

  it('listening resets the retry budget and re-posts init at once', () => {
    const iframe = fakeIframe()
    const onEvent = vi.fn()
    const bridge = createBridge(iframe, onEvent)
    // Burn the whole retry budget.
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * (BRIDGE_INIT_MAX_TRIES + 5))
    expect(iframe.postMessage).toHaveBeenCalledTimes(BRIDGE_INIT_MAX_TRIES)
    // A late listening announcement restarts the loop.
    dispatchFromIframe(iframe, '{"type":"op-bridge/listening"}')
    expect(iframe.postMessage).toHaveBeenCalledTimes(BRIDGE_INIT_MAX_TRIES + 1)
    expect(onEvent).toHaveBeenCalledWith({ type: 'listening' })
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS)
    expect(iframe.postMessage).toHaveBeenCalledTimes(BRIDGE_INIT_MAX_TRIES + 2)
    bridge.dispose()
  })

  it('ready stops the retry loop', () => {
    const iframe = fakeIframe()
    const bridge = createBridge(iframe)
    dispatchFromIframe(iframe, '{"type":"op-bridge/ready","generation":2,"revision":17}')
    const posts = iframe.postMessage.mock.calls.length
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * 10)
    expect(iframe.postMessage).toHaveBeenCalledTimes(posts)
    bridge.dispose()
  })

  it('ignores messages from a foreign origin or a foreign source', () => {
    const iframe = fakeIframe()
    const onEvent = vi.fn()
    const bridge = createBridge(iframe, onEvent)
    // Foreign origin.
    dispatchFromIframe(
      iframe,
      '{"type":"op-bridge/ready","generation":2,"revision":17}',
      'http://evil.example'
    )
    // Foreign source (same origin, different window).
    const foreign = new MessageEvent('message', {
      data: '{"type":"op-bridge/ready","generation":2,"revision":17}'
    })
    Object.defineProperty(foreign, 'origin', { value: IFRAME_ORIGIN })
    Object.defineProperty(foreign, 'source', { value: { postMessage: vi.fn() } })
    window.dispatchEvent(foreign)
    expect(onEvent).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('routes editor events to onEvent and stops retrying after ready', () => {
    const iframe = fakeIframe()
    const onEvent = vi.fn()
    const bridge = createBridge(iframe, onEvent)
    dispatchFromIframe(iframe, '{"type":"op-bridge/ready","generation":2,"revision":17}')
    dispatchFromIframe(
      iframe,
      '{"type":"op-bridge/dirty-changed","generation":3,"revision":18,"dirty":true}'
    )
    expect(onEvent).toHaveBeenCalledWith({ type: 'ready', generation: 2, revision: 17 })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'dirty-changed',
      generation: 3,
      revision: 18,
      dirty: true
    })
    bridge.dispose()
  })

  it('op-shell/save and op-shell/copy reach their callbacks', () => {
    const iframe = fakeIframe()
    const onShellSave = vi.fn()
    const onShellCopy = vi.fn()
    const bridge = createCanvasBridge({
      iframe: iframe.element,
      iframeOrigin: IFRAME_ORIGIN,
      token: 't0k',
      onEvent: vi.fn(),
      onShellSave,
      onShellCopy
    })
    dispatchFromIframe(iframe, '{"type":"op-shell/save"}')
    dispatchFromIframe(iframe, '{"type":"op-shell/copy","text":"design tokens"}')
    expect(onShellSave).toHaveBeenCalledTimes(1)
    expect(onShellCopy).toHaveBeenCalledWith('design tokens')
    bridge.dispose()
  })

  it('outbound host messages post with the explicit iframe origin', () => {
    const iframe = fakeIframe()
    const bridge = createBridge(iframe)
    iframe.postMessage.mockClear()
    bridge.sendTheme('dark')
    bridge.sendLocale('zh-CN')
    bridge.sendSaveCommitted(3, 41)
    bridge.sendResolveConflict('use-local', 'r1')
    expect(iframe.postMessage).toHaveBeenCalledTimes(4)
    for (const call of iframe.postMessage.mock.calls) {
      expect(call[1]).toBe(IFRAME_ORIGIN)
    }
    expect(parsePosted(iframe.postMessage.mock.calls[0][0])).toEqual({
      type: 'op-bridge/theme',
      colorScheme: 'dark'
    })
    expect(parsePosted(iframe.postMessage.mock.calls[2][0])).toEqual({
      type: 'op-bridge/save-committed',
      generation: 3,
      revision: 41
    })
    bridge.dispose()
  })

  it('dispose removes the listener and clears the retry timer', () => {
    const iframe = fakeIframe()
    const onEvent = vi.fn()
    const bridge = createBridge(iframe, onEvent)
    bridge.dispose()
    const posts = iframe.postMessage.mock.calls.length
    vi.advanceTimersByTime(BRIDGE_INIT_RETRY_MS * 30)
    dispatchFromIframe(iframe, '{"type":"op-bridge/ready","generation":2,"revision":17}')
    expect(iframe.postMessage).toHaveBeenCalledTimes(posts)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('exposes the verbatim editor + shell message constants', () => {
    expect(BRIDGE_EDITOR_MESSAGES.DIRTY_CHANGED).toBe('op-bridge/dirty-changed')
    expect(BRIDGE_EDITOR_MESSAGES.SYNC_CONFLICT).toBe('op-bridge/sync-conflict')
    expect(BRIDGE_EDITOR_MESSAGES.CONFLICT_RESOLVED).toBe('op-bridge/conflict-resolved')
    expect(SHELL_CONTROL_MESSAGES.SAVE).toBe('op-shell/save')
    expect(SHELL_CONTROL_MESSAGES.COPY).toBe('op-shell/copy')
  })
})
