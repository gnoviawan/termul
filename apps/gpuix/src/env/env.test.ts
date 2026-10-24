import { describe, expect, test } from 'bun:test'
import { createHashHistory } from '@remix-run/router'
import { cssEscape, MediaList } from './dom'
import { createSessionHistory } from './history'
import { readInitialWindowSize } from './window-size'

const ORIGIN = new URL('http://127.0.0.1:8190')
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('session history', () => {
  test('pushState and back behave like a browser tab', async () => {
    const events = new EventTarget()
    const { location, history } = createSessionHistory(ORIGIN, events)
    const pops: unknown[] = []
    events.addEventListener('popstate', (event) => pops.push((event as PopStateEvent).state))

    history.pushState({ idx: 1 }, '', '#/c/session-1')
    expect(location.href).toBe('http://127.0.0.1:8190/#/c/session-1')
    expect(location.hash).toBe('#/c/session-1')
    expect(history.length).toBe(2)
    expect(pops).toEqual([])

    history.back()
    expect(location.hash).toBe('#/c/session-1')
    await tick()
    expect(location.hash).toBe('')
    expect(pops).toEqual([null])
  })

  test('replaceState swaps the entry, a hash write pushes and fires hashchange', async () => {
    const events = new EventTarget()
    const { location, history } = createSessionHistory(ORIGIN, events)
    const changes: string[] = []
    events.addEventListener('hashchange', (event) => changes.push((event as HashChangeEvent).newURL))

    history.replaceState({ termulOverlay: true }, '', '#/')
    expect(history.state).toEqual({ termulOverlay: true })
    expect(history.length).toBe(1)

    location.hash = '#/snapshots'
    expect(history.length).toBe(2)
    await tick()
    expect(changes).toEqual(['http://127.0.0.1:8190/#/snapshots'])
  })

  test('a cross-origin URL is refused', () => {
    const { history } = createSessionHistory(ORIGIN, new EventTarget())
    expect(() => history.pushState(null, '', 'http://example.com/')).toThrow('not same-origin')
  })

  test("react-router's hash history navigates on it", async () => {
    const events = new EventTarget()
    const session = createSessionHistory(ORIGIN, events)
    const window = Object.assign(events, {
      location: session.location,
      history: session.history,
      document: { defaultView: null, querySelector: () => null }
    }) as unknown as Window
    const router = createHashHistory({ window, v5Compat: true })
    const seen: string[] = []
    router.listen(({ location }) => seen.push(location.pathname))

    router.push('/c/abc')
    expect(session.location.hash).toBe('#/c/abc')
    expect(router.location.pathname).toBe('/c/abc')
    session.history.back()
    await tick()
    expect(router.location.pathname).toBe('/')
    expect(seen).toEqual(['/c/abc', '/'])
  })
})

describe('initial window size', () => {
  test('the desktop app size by default', () => {
    expect(readInitialWindowSize({})).toEqual({ width: 1200, height: 800 })
  })

  test('GPUIX_WINDOW_SIZE pins it, raised to the desktop minimum', () => {
    expect(readInitialWindowSize({ GPUIX_WINDOW_SIZE: '1280x800' })).toEqual({ width: 1280, height: 800 })
    expect(readInitialWindowSize({ GPUIX_WINDOW_SIZE: '640x480' })).toEqual({ width: 800, height: 600 })
  })

  test('a malformed size is refused', () => {
    expect(() => readInitialWindowSize({ GPUIX_WINDOW_SIZE: 'big' })).toThrow('WIDTHxHEIGHT')
  })
})

describe('matchMedia lists', () => {
  test('a resize that flips the answer fires change once; a removed listener hears nothing', () => {
    let size = { width: 1280, height: 800 }
    const registry = new Set<MediaList>()
    const list = new MediaList('(max-width: 767px)', () => size, false, registry)
    const heard: boolean[] = []
    const listener = (event: Event) => heard.push((event as MediaQueryListEvent).matches)
    list.addEventListener('change', listener)
    expect(list.matches).toBe(false)
    expect(registry.size).toBe(1)

    size = { width: 1000, height: 700 }
    list.reevaluate()
    size = { width: 700, height: 700 }
    list.reevaluate()
    list.reevaluate()
    expect(heard).toEqual([true])

    list.removeEventListener('change', listener)
    expect(registry.size).toBe(0)
  })
})

describe('CSS.escape', () => {
  test('matches the browser for ids the renderer builds', () => {
    expect(cssEscape('ssh-tab-hosts')).toBe('ssh-tab-hosts')
    expect(cssEscape('1abc')).toBe('\\31 abc')
    expect(cssEscape('-2')).toBe('-\\32 ')
    expect(cssEscape('-')).toBe('\\-')
    expect(cssEscape('a b.c#d')).toBe('a\\ b\\.c\\#d')
    expect(cssEscape('/tmp/x"y')).toBe('\\/tmp\\/x\\"y')
    expect(cssEscape('\u00e9\u0000')).toBe('\u00e9\uFFFD')
  })
})
