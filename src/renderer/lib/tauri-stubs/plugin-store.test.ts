import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '@/lib/tauri-stubs/plugin-store'

describe('plugin-store localStorage stub', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('round-trips get/set/delete and reports keys/length/has/values/entries', async () => {
    const store = await Store.load('app-data.json')
    expect(await store.get('missing')).toBeUndefined()
    expect(await store.has('a')).toBe(false)

    await store.set('a', { n: 1 })
    expect(await store.has('a')).toBe(true)
    expect(await store.get<{ n: number }>('a')).toEqual({ n: 1 })
    expect(await store.keys()).toEqual(['a'])
    expect(await store.length()).toBe(1)
    expect(await store.values()).toEqual([{ n: 1 }])
    expect(await store.entries()).toEqual([['a', { n: 1 }]])

    await store.delete('a')
    expect(await store.get('a')).toBeUndefined()
    expect(await store.has('a')).toBe(false)
    expect(await store.keys()).toEqual([])
  })

  it('namespaces by path — two stores never bleed', async () => {
    const alpha = await Store.load('alpha.json')
    const beta = await Store.load('beta.json')
    await alpha.set('shared-key', 'from-alpha')
    await beta.set('shared-key', 'from-beta')
    expect(await alpha.get<string>('shared-key')).toBe('from-alpha')
    expect(await beta.get<string>('shared-key')).toBe('from-beta')
    expect(await alpha.keys()).toEqual(['shared-key'])
    expect(await beta.keys()).toEqual(['shared-key'])
    // clearing one store does not touch the other
    await alpha.clear()
    expect(await alpha.get('shared-key')).toBeUndefined()
    expect(await beta.get<string>('shared-key')).toBe('from-beta')
  })

  it('clear and reset remove only namespaced entries', async () => {
    const store = await Store.load('gamma.json')
    await store.set('k1', 1)
    await store.set('k2', 2)
    const other = await Store.load('delta.json')
    await other.set('k3', 3)

    await store.reset()
    expect(await store.keys()).toEqual([])
    expect(await other.get('k3')).toBe(3)
  })

  it('save is a no-op (set already persists immediately)', async () => {
    const store = await Store.load('eps.json')
    await store.set('x', 42)
    await store.save() // must not throw
    expect(await store.get('x')).toBe(42)
  })

  it('degrades silently on corrupt JSON (returns undefined)', async () => {
    const store = await Store.load('corrupt.json')
    // write raw garbage straight into localStorage under the namespace
    localStorage.setItem('termul-store:corrupt.json::bad', '{not-json')
    expect(await store.get('bad')).toBeUndefined()
  })

  it('degrades silently when setItem throws (quota / security)', async () => {
    const store = await Store.load('quota.json')
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    await expect(store.set('big', 'x'.repeat(10))).resolves.toBeUndefined()
    expect(await store.get('big')).toBeUndefined()
    spy.mockRestore()
  })

  it('returns empty/undefined defaults when localStorage is unavailable (SSR)', async () => {
    vi.stubGlobal('localStorage', undefined)
    const store = await Store.load('ssr.json')
    expect(await store.get('any')).toBeUndefined()
    expect(await store.has('any')).toBe(false)
    expect(await store.keys()).toEqual([])
    expect(await store.length()).toBe(0)
    await expect(store.set('any', 'x')).resolves.toBeUndefined()
    await expect(store.delete('any')).resolves.toBeUndefined()
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('applies defaults for absent keys on load and never overwrites existing', async () => {
    const store = await Store.load('defs.json', {
      autoSave: false,
      defaults: { greeting: 'hi', count: 3 }
    })
    expect(await store.get<string>('greeting')).toBe('hi')
    expect(await store.get('count')).toBe(3)

    // A pre-existing value must not be overwritten by defaults on a later load.
    await store.set('count', 99)
    const reloaded = await Store.load('defs.json', { defaults: { count: 3 } })
    expect(await reloaded.get('count')).toBe(99)
  })

  it('reset() re-applies the defaults passed to load() after clearing', async () => {
    const store = await Store.load('reset-defaults.json', { defaults: { a: 1 } })
    expect(await store.get('a')).toBe(1)
    // Overwrite the default; reset must restore it (Tauri parity).
    await store.set('a', 99)
    expect(await store.get('a')).toBe(99)
    await store.reset()
    expect(await store.get('a')).toBe(1)
  })

  it('clear() on a namespace containing `::` does not bleed into a namespace it prefixes', async () => {
    // `a.json` and `a::b.json` — without namespace escaping, `clear()` on
    // `a.json` prefix-matches `termul-store:a.json::` over `termul-store:a::b.json::`
    // and would delete `a::b.json`'s keys too.
    const a = await Store.load('a.json')
    const ab = await Store.load('a::b.json')
    await a.set('k', 'from-a')
    await ab.set('k', 'from-ab')
    expect(await ab.get<string>('k')).toBe('from-ab')

    await a.clear()
    // `a.json` cleared its own key; `a::b.json` is untouched.
    expect(await a.get('k')).toBeUndefined()
    expect(await ab.get<string>('k')).toBe('from-ab')
    expect(await ab.keys()).toEqual(['k'])
  })
})
