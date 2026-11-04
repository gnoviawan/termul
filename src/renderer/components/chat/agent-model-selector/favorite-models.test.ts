import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFavoritesStore,
  FAVORITES_STORAGE_KEY,
  type FavoriteKey,
  type FavoriteModel,
  type FavoritesAdapter,
  favoritePath,
  localStorageAdapter,
  memoryFavoritesAdapter,
  parseFavorites
} from './favorite-models'
import { resolveFavorites } from './selector-model'

const OPUS = { configId: 'claude', modelId: 'opus' }
const SONNET = { configId: 'cursor', modelId: 'sonnet' }

/** A clock that ticks one minute per call. */
function clock(): () => Date {
  let minute = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, minute++))
}

/** Resolves or rejects a pending write from the test. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve = (): void => {}
  let reject: (e: Error) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function memoryStorage(initial: string | null = null): Pick<Storage, 'getItem' | 'setItem'> & {
  raw: () => string | null
} {
  let raw = initial
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value
    },
    raw: () => raw
  }
}

describe('favoritePath', () => {
  it('encodes both segments', () => {
    expect(favoritePath({ configId: 'acp-registry:claude', modelId: 'anthropic/opus 4?' })).toBe(
      '/me/favorite-models/acp-registry%3Aclaude/anthropic%2Fopus%204%3F'
    )
  })
})

describe('parseFavorites', () => {
  it.each([
    ['missing', null],
    ['not JSON', '{nope'],
    ['not an array', '{"configId":"a"}'],
    ['wrong shapes', '[1, null, {"configId":"a"}, {"configId":"","modelId":"x","addedAt":"t"}]']
  ])('reads %s storage as an empty list', (_label, raw) => {
    expect(parseFavorites(raw)).toEqual([])
  })

  it('keeps the first of duplicate entries', () => {
    const a = { ...OPUS, addedAt: '2026-01-01T00:00:00.000Z' }
    const b = { ...OPUS, addedAt: '2026-02-01T00:00:00.000Z' }
    expect(parseFavorites(JSON.stringify([a, b]))).toEqual([a])
  })
})

describe('createFavoritesStore', () => {
  it('orders by addedAt and keeps a stable list reference between changes', () => {
    const store = createFavoritesStore(
      memoryFavoritesAdapter([
        { ...SONNET, addedAt: '2026-01-02T00:00:00.000Z' },
        { ...OPUS, addedAt: '2026-01-01T00:00:00.000Z' }
      ])
    )
    expect(store.list().map((f) => f.modelId)).toEqual(['opus', 'sonnet'])
    expect(store.list()).toBe(store.list())
  })

  it('set is idempotent and keeps the first addedAt', async () => {
    const storage = memoryStorage()
    const store = createFavoritesStore(localStorageAdapter(storage), clock())
    let changes = 0
    store.subscribe(() => changes++)
    await store.set(OPUS, true)
    const first = store.list()
    await store.set(OPUS, true)
    expect(store.list()).toBe(first)
    expect(store.list()).toEqual([{ ...OPUS, addedAt: '2026-01-01T00:00:00.000Z' }])
    expect(parseFavorites(storage.raw())).toEqual(store.list())
    await store.set(SONNET, false)
    expect(changes).toBe(1)
    await store.set(OPUS, false)
    await store.set(OPUS, false)
    expect(store.list()).toEqual([])
    expect(changes).toBe(2)
  })

  it('persists under the v1 key and reloads', async () => {
    const storage = memoryStorage()
    await createFavoritesStore(localStorageAdapter(storage), clock()).set(SONNET, true)
    const reloaded = createFavoritesStore(localStorageAdapter(storage, FAVORITES_STORAGE_KEY))
    expect(reloaded.list()).toEqual([{ ...SONNET, addedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('starts empty on corrupt storage', () => {
    expect(createFavoritesStore(localStorageAdapter(memoryStorage('{nope'))).list()).toEqual([])
  })

  it('applies at once and rolls back a failed write', async () => {
    const pending = deferred()
    const adapter: FavoritesAdapter = {
      load: () => [],
      put: () => pending.promise,
      remove: () => Promise.resolve()
    }
    const store = createFavoritesStore(adapter, clock())
    const write = store.set(OPUS, true)
    expect(store.list()).toEqual([expect.objectContaining(OPUS)])
    pending.reject(new Error('offline'))
    await expect(write).rejects.toThrow('offline')
    expect(store.list()).toEqual([])
  })

  it('rolls an unstar back with its original addedAt', async () => {
    const saved: FavoriteModel = { ...OPUS, addedAt: '2025-06-01T00:00:00.000Z' }
    const store = createFavoritesStore({
      load: () => [saved],
      put: () => Promise.resolve(),
      remove: () => Promise.reject(new Error('offline'))
    })
    await expect(store.set(OPUS, false)).rejects.toThrow('offline')
    expect(store.list()).toEqual([saved])
  })

  it('per key, the last write wins: an older failure does not undo a newer write', async () => {
    const puts = [deferred(), deferred()]
    const removes = [deferred()]
    let p = 0
    let r = 0
    const store = createFavoritesStore(
      {
        load: () => [],
        put: () => (puts[p++] as ReturnType<typeof deferred>).promise,
        remove: () => (removes[r++] as ReturnType<typeof deferred>).promise
      },
      clock()
    )
    const first = store.set(OPUS, true)
    const second = store.set(OPUS, false)
    const third = store.set(OPUS, true)
    expect(store.list()).toEqual([expect.objectContaining(OPUS)])
    // The first two fail after the third started: the star stays on.
    puts[0]?.reject(new Error('late'))
    removes[0]?.reject(new Error('late'))
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    expect(store.list()).toEqual([expect.objectContaining(OPUS)])
    puts[1]?.resolve()
    await third
    expect(store.list()).toEqual([expect.objectContaining(OPUS)])
  })

  it('keeps stale favorites; the panel hides them', async () => {
    const store = createFavoritesStore(
      memoryFavoritesAdapter([
        { ...OPUS, addedAt: '2026-01-01T00:00:00.000Z' },
        { configId: 'removed-agent', modelId: 'x', addedAt: '2026-01-02T00:00:00.000Z' }
      ])
    )
    const catalog = {
      id: 'model',
      source: 'config' as const,
      currentValue: null,
      options: [{ value: 'opus', name: 'Opus' }]
    }
    const shown = resolveFavorites(store.list(), (id) => (id === 'claude' ? catalog : null))
    expect(shown.map((f) => f.model.name)).toEqual(['Opus'])
    expect(store.list()).toHaveLength(2)
  })
})

describe('createFavoritesStore across windows', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()
  /** What another window does: write the key, then the browser fires `storage` here. */
  function otherWindowWrites(key: string, items: readonly FavoriteModel[]): void {
    const value = JSON.stringify(items)
    localStorage.setItem(key, value)
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: value, storageArea: localStorage })
    )
  }

  afterEach(() => localStorage.clear())

  it('a storage event for the favorites key reloads the list and notifies subscribers', () => {
    const store = createFavoritesStore(localStorageAdapter())
    const onChange = vi.fn()
    const unsubscribe = store.subscribe(onChange)
    expect(store.list()).toEqual([])

    otherWindowWrites(FAVORITES_STORAGE_KEY, [{ ...SONNET, addedAt: at(1) }])

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(store.list()).toEqual([{ ...SONNET, addedAt: at(1) }])
    unsubscribe()
  })

  it('ignores storage events for other keys', () => {
    const store = createFavoritesStore(localStorageAdapter())
    const onChange = vi.fn()
    const unsubscribe = store.subscribe(onChange)
    const before = store.list()

    otherWindowWrites('termul.somethingElse', [{ ...SONNET, addedAt: at(1) }])

    expect(onChange).not.toHaveBeenCalled()
    expect(store.list()).toBe(before)
    unsubscribe()
  })

  it('watches only while something is subscribed', () => {
    const added: unknown[] = []
    const events = {
      addEventListener: vi.fn((_type: string, fn: unknown) => added.push(fn)),
      removeEventListener: vi.fn()
    }
    const store = createFavoritesStore(
      localStorageAdapter(memoryStorage(), FAVORITES_STORAGE_KEY, events as never)
    )
    expect(events.addEventListener).not.toHaveBeenCalled()

    const first = store.subscribe(() => {})
    const second = store.subscribe(() => {})
    expect(events.addEventListener).toHaveBeenCalledTimes(1)
    expect(events.addEventListener).toHaveBeenCalledWith('storage', added[0])

    first()
    expect(events.removeEventListener).not.toHaveBeenCalled()
    second()
    expect(events.removeEventListener).toHaveBeenCalledTimes(1)
    expect(events.removeEventListener).toHaveBeenCalledWith('storage', added[0])
  })

  it('after the last unsubscribe, events no longer reach the store', () => {
    const store = createFavoritesStore(localStorageAdapter())
    const onChange = vi.fn()
    store.subscribe(onChange)()

    otherWindowWrites(FAVORITES_STORAGE_KEY, [{ ...SONNET, addedAt: at(1) }])

    expect(onChange).not.toHaveBeenCalled()
    expect(store.list()).toEqual([])
    // Subscribing again catches up on what was written meanwhile.
    store.subscribe(() => {})
    expect(store.list()).toEqual([{ ...SONNET, addedAt: at(1) }])
  })

  it('a write in flight keeps its optimistic value through an outside change', async () => {
    const write = deferred()
    const base = localStorageAdapter()
    const adapter: FavoritesAdapter = { ...base, put: () => write.promise }
    const store = createFavoritesStore(adapter, clock())
    const unsubscribe = store.subscribe(() => {})

    const pending = store.set(OPUS, true)
    otherWindowWrites(FAVORITES_STORAGE_KEY, [{ ...SONNET, addedAt: at(5) }])

    expect(store.list().map((f) => f.modelId)).toEqual(['opus', 'sonnet'])
    write.resolve()
    await pending
    unsubscribe()
  })
})

describe('favorites with option snapshots', () => {
  const HIGH = { ...OPUS, options: { effort: 'high', fast: 'false' } }
  const LOW = { ...OPUS, options: { effort: 'low' } }

  it('two snapshots of one model are two favorites; unstarring one keeps the other', async () => {
    const store = createFavoritesStore(memoryFavoritesAdapter(), clock())
    await store.set(HIGH, true)
    await store.set(LOW, true)
    await store.set(OPUS, true)
    expect(store.list()).toEqual([
      { ...HIGH, addedAt: '2026-01-01T00:00:00.000Z' },
      { ...LOW, addedAt: '2026-01-01T00:01:00.000Z' },
      { ...OPUS, addedAt: '2026-01-01T00:02:00.000Z' }
    ])

    await store.set({ ...OPUS, options: { fast: 'false', effort: 'high' } }, false)
    expect(store.list().map((f) => f.options)).toEqual([{ effort: 'low' }, undefined])
  })

  it('an empty snapshot is stored as none', async () => {
    const store = createFavoritesStore(memoryFavoritesAdapter(), clock())
    await store.set({ ...OPUS, options: {} }, true)
    expect(store.list()).toEqual([{ ...OPUS, addedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('reads legacy entries unchanged and drops a malformed snapshot', () => {
    const legacy = { ...OPUS, addedAt: '2026-01-01T00:00:00.000Z' }
    const bad = { ...SONNET, options: { effort: 3 }, addedAt: '2026-01-02T00:00:00.000Z' }
    expect(parseFavorites(JSON.stringify([legacy, bad]))).toEqual([legacy])
  })

  it('the backend path names the snapshot', () => {
    expect(favoritePath(LOW)).toBe(
      `/me/favorite-models/claude/opus?options=${encodeURIComponent('[["effort","low"]]')}`
    )
  })

  describe('Favorites row labels', () => {
    const catalog = {
      id: 'model',
      source: 'config' as const,
      currentValue: null,
      options: [{ value: 'opus', name: 'Opus' }]
    }
    const effort = {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Gentle' },
        { value: 'high', name: 'Hard' }
      ]
    }
    const fast = {
      id: 'fast_mode',
      name: 'Fast mode',
      type: 'select' as const,
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' }
      ]
    }
    const labels = (
      favorites: Array<FavoriteKey & { addedAt: string }>,
      options: Parameters<typeof resolveFavorites>[3]
    ) => resolveFavorites(favorites, () => catalog, undefined, options).map((f) => f.label)

    it('shows the effort a snapshot holds, by the option name when known', () => {
      const favorites = [
        { ...HIGH, addedAt: 'a' },
        { ...LOW, addedAt: 'b' },
        { ...OPUS, addedAt: 'c' }
      ]
      expect(labels(favorites, () => [effort])).toEqual(['Hard', 'Gentle', null])
      expect(labels(favorites, undefined)).toEqual(['High', 'Low', null])
    })

    it('never reads an on/off value as the effort', () => {
      const thinking = { ...OPUS, options: { thinking: 'true', reasoning_effort: 'max' } }
      expect(labels([{ ...thinking, addedAt: 'a' }], undefined)).toEqual(['Max'])
      const onlyToggle = { ...OPUS, options: { thinking: 'true' } }
      expect(labels([{ ...onlyToggle, addedAt: 'a' }], undefined)).toEqual([null])
    })

    it('adds Fast when two favorites of a model share an effort', () => {
      const favorites = [
        { ...OPUS, options: { effort: 'high', fast_mode: 'on' }, addedAt: 'a' },
        { ...OPUS, options: { effort: 'high', fast_mode: 'off' }, addedAt: 'b' },
        { ...OPUS, options: { effort: 'low', fast_mode: 'on' }, addedAt: 'c' }
      ]
      expect(labels(favorites, () => [effort, fast])).toEqual(['Hard · Fast', 'Hard', 'Gentle'])
      expect(labels(favorites, undefined)).toEqual(['High · Fast', 'High', 'Low'])
    })

    it('names the differing value of any other option', () => {
      const favorites = [
        { ...OPUS, options: { effort: 'high', context: '1m' }, addedAt: 'a' },
        { ...OPUS, options: { effort: 'high', context: '200k' }, addedAt: 'b' }
      ]
      expect(labels(favorites, () => [effort])).toEqual(['Hard · 1m', 'Hard · 200k'])
    })
  })
})
