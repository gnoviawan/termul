import { afterEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { createGpuixBrowserHost, type GpuixBrowserHost, helperEnv } from './browser-host'
import { encodeCommand, parseEvent } from './protocol'
import { detectBrowserSupport } from './support'

const FAKE = path.join(import.meta.dir, '__fixtures__/fake-webview-host.ts')
const BOUNDS = { x: 0, y: 36, width: 640, height: 400 }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await wait(10)
  }
}

let host: GpuixBrowserHost | null = null
afterEach(() => {
  host?.kill()
  host = null
})

function fakeHost(focus: { id: number | null; blurs: number } = { id: null, blurs: 0 }) {
  host = createGpuixBrowserHost({
    binary: FAKE,
    parentPid: process.pid,
    focusedElement: () => focus.id,
    blurApp: () => {
      focus.blurs += 1
      focus.id = null
    },
    focusPollMs: 10
  })
  return host
}

describe('protocol', () => {
  test('encodes one command per line', () => {
    expect(encodeCommand({ op: 'bounds', req: 2, id: 't1', bounds: BOUNDS })).toBe(
      '{"op":"bounds","req":2,"id":"t1","bounds":{"x":0,"y":36,"width":640,"height":400}}\n'
    )
    expect(encodeCommand({ op: 'quit' })).toBe('{"op":"quit"}\n')
  })

  test('parses well-formed events and rejects the rest', () => {
    expect(parseEvent('{"ev":"ack","req":4,"ok":false,"error":"no such tab: t9"}')).toEqual({
      ev: 'ack',
      req: 4,
      ok: false,
      error: 'no such tab: t9'
    })
    expect(parseEvent('{"ev":"keyboard","owner":null}')).toEqual({ ev: 'keyboard', owner: null })
    expect(parseEvent('{"ev":"title","id":"t1","title":"Docs"}')).toEqual({
      ev: 'title',
      id: 't1',
      title: 'Docs'
    })
    expect(parseEvent('{"ev":"ack","req":4,"ok":false}')).toBeNull()
    expect(parseEvent('{"ev":"canvasMessage","id":"c1","data":"{\\"id\\":1}"}')).toEqual({
      ev: 'canvasMessage',
      id: 'c1',
      data: '{"id":1}'
    })
    expect(parseEvent('{"ev":"canvasMessage","id":"c1"}')).toBeNull()
    expect(parseEvent('{"ev":"title","id":"t1"}')).toBeNull()
    expect(parseEvent('{"ev":"keyboard","owner":3}')).toBeNull()
    expect(parseEvent('{"ev":"later"}')).toBeNull()
    expect(parseEvent('[1]')).toBeNull()
    expect(parseEvent('Gtk-WARNING')).toBeNull()
  })
})

describe('browser support', () => {
  const exists = (file: string) => file === '/app/dist/termul-webview-host'
  test('X11 Linux with the helper beside the bundle', () => {
    expect(detectBrowserSupport({ DISPLAY: ':0' }, 'linux', '/app/dist', exists)).toEqual({
      kind: 'x11',
      binary: '/app/dist/termul-webview-host'
    })
  })
  test('Wayland, no display, other platforms, and a missing helper are unsupported', () => {
    expect(
      detectBrowserSupport(
        { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
        'linux',
        '/app/dist',
        exists
      )
    ).toEqual({
      kind: 'unsupported',
      reason:
        'GPUI runs on Wayland here (WAYLAND_DISPLAY=wayland-0) and the webview helper attaches to X11 windows only'
    })
    expect(detectBrowserSupport({}, 'linux', '/app/dist', exists)).toEqual({
      kind: 'unsupported',
      reason: 'no X11 DISPLAY'
    })
    expect(detectBrowserSupport({ DISPLAY: ':0' }, 'darwin', '/app/dist', exists).kind).toBe(
      'unsupported'
    )
    expect(detectBrowserSupport({ DISPLAY: ':0' }, 'linux', '/elsewhere', exists)).toEqual({
      kind: 'unsupported',
      reason: '/elsewhere/termul-webview-host is missing (bun run build builds it)'
    })
    expect(
      detectBrowserSupport(
        { DISPLAY: ':0', TERMUL_WEBVIEW_HOST_BIN: '/app/dist/termul-webview-host' },
        'linux',
        '/x',
        exists
      ).kind
    ).toBe('x11')
  })
})

describe('GPUIX browser host over the helper protocol', () => {
  test('create resolves with the tab and the helper events reach the facade subscribers', async () => {
    const h = fakeHost()
    const seen: string[] = []
    h.onNavigated((p) => seen.push(`navigated ${p.browserTabId} ${p.url}`))
    h.onLoaded((p) => seen.push(`loaded ${p.browserTabId}`))
    h.onTitleChanged((p) => seen.push(`title ${p.browserTabId} ${p.title}`))

    expect(await h.create('t1', 'http://127.0.0.1:9/', BOUNDS)).toEqual({
      success: true,
      data: { id: 't1', url: 'http://127.0.0.1:9/', title: '', agentControlled: false }
    })
    await until(() => seen.length === 3)
    expect(seen).toEqual(['navigated t1 http://127.0.0.1:9/', 'loaded t1', 'title t1 title of t1'])
    expect(await h.resize('t1', BOUNDS)).toEqual({ success: true, data: undefined })
  })

  test('a helper error becomes a failed IpcResult', async () => {
    const h = fakeHost()
    await h.create('t1', 'http://127.0.0.1:9/', BOUNDS)
    expect(await h.navigate('t1', 'http://127.0.0.1:9/fail')).toEqual({
      success: false,
      error: 'cannot load http://127.0.0.1:9/fail',
      code: 'WEBVIEW_HOST'
    })
  })

  test('tab commands with no helper running fail without starting one', async () => {
    const h = fakeHost()
    expect(await h.show('t1')).toEqual({
      success: false,
      error: 'no webview for tab t1',
      code: 'WEBVIEW_HOST'
    })
    expect(h.helperPid()).toBeUndefined()
  })

  test('a webview taking the keyboard blurs GPUIX, and the next GPUIX focus takes it back', async () => {
    const focus = { id: 42 as number | null, blurs: 0 }
    const h = fakeHost(focus)
    await h.create('grab', 'http://127.0.0.1:9/', BOUNDS)
    await h.show('grab')
    await until(() => h.keyboardOwner() === 'grab')
    expect(focus).toEqual({ id: null, blurs: 1 })

    focus.id = 7
    await until(() => h.keyboardOwner() === null)
    expect(focus.blurs).toBe(1)
  })

  test('a crashed helper fails its pending request and the next create starts a new one', async () => {
    const h = fakeHost()
    await h.create('t1', 'http://127.0.0.1:9/', BOUNDS)
    const first = h.helperPid()
    const crashed = await h.create('crash', 'http://127.0.0.1:9/', BOUNDS)
    expect(crashed).toEqual({
      success: false,
      error: 'webview host exited with 3',
      code: 'WEBVIEW_HOST'
    })
    await until(() => h.helperPid() === undefined)
    expect((await h.create('t2', 'http://127.0.0.1:9/', BOUNDS)).success).toBe(true)
    expect(h.helperPid()).not.toBe(first)
  })

  test('a canvas passes messages both ways; its helper dying reports it gone, a destroyed one not', async () => {
    const h = fakeHost()
    expect(await h.createCanvas('c1', 'http://127.0.0.1:9/canvas/a/b/', BOUNDS)).toEqual({
      success: true,
      data: undefined
    })
    expect(await h.createCanvas('c2', 'http://127.0.0.1:9/canvas/a/b/', BOUNDS)).toEqual({
      success: true,
      data: undefined
    })
    await h.destroy('c2')
    const gone: string[] = []
    h.onCanvasGone('c1', (reason) => gone.push(`c1 ${reason}`))
    h.onCanvasGone('c2', (reason) => gone.push(`c2 ${reason}`))
    expect(await h.postToCanvas('c1', '{"id":1}')).toEqual({ success: true, data: undefined })
    void h.postToCanvas('c1', '"die"')
    await until(() => gone.length > 0)
    expect(gone).toEqual(['c1 webview host exited with 3'])
  })

  test('a canvas helper that is shut down reports nothing gone', async () => {
    const h = fakeHost()
    await h.createCanvas('c1', 'http://127.0.0.1:9/canvas/a/b/', BOUNDS)
    const gone: string[] = []
    h.onCanvasGone('c1', (reason) => gone.push(reason))
    h.shutdown()
    await until(() => h.helperPid() === undefined)
    expect(gone).toEqual([])
  })

  test('shutdown ends the helper', async () => {
    const h = fakeHost()
    await h.create('t1', 'http://127.0.0.1:9/', BOUNDS)
    expect(h.helperPid()).toBeNumber()
    h.shutdown()
    await until(() => h.helperPid() === undefined)
  })
})

describe('helper environment', () => {
  test('a dark Termul starts WebKitGTK on the dark variant of the GTK theme', () => {
    expect(helperEnv({ PATH: '/bin' }, true)).toEqual({ PATH: '/bin', GTK_THEME: 'Adwaita:dark' })
    expect(helperEnv({ GTK_THEME: 'Yaru:light' }, true)).toEqual({ GTK_THEME: 'Yaru:dark' })
  })

  test('a light Termul leaves the environment as it is', () => {
    const env = { GTK_THEME: 'Yaru' }
    expect(helperEnv(env, false)).toBe(env)
  })
})
