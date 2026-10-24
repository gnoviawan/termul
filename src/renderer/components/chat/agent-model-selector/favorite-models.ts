import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * Starred models.
 *
 * `configId` is the STORE id that `armableConfigId` returns, never the
 * registry agent id: picking a favorite arms that config.
 *
 * The UI only talks to `FavoritesStore`. Today the adapter is localStorage;
 * a backend adapter drops in behind the same store with no UI change.
 *
 * Backend contract (not built yet):
 * - `GET /me/favorite-models` → `{ items: FavoriteModel[] }`
 * - `PUT /me/favorite-models/{configId}/{modelId}` → 204, idempotent
 *   (a repeat keeps the first `addedAt`)
 * - `DELETE /me/favorite-models/{configId}/{modelId}` → 204, idempotent
 *   (a missing favorite is not an error)
 * - Path segments are encoded with `favoritePath` (configIds contain `:`).
 * - First run against the backend: PUT each local favorite, then clear
 *   `termul.favoriteModels.v1`.
 * - The HTTP adapter must queue writes per key: a PUT and a DELETE for the
 *   same `configId`+`modelId` go out one after the other, each sent only
 *   once the previous one has settled. The store already resolves races
 *   locally (last write wins, rollback only for the newest), but two
 *   requests in flight for one key can reach the server out of order and
 *   leave it holding the older state. Different keys may run in parallel.
 */
export type FavoriteKey = { configId: string; modelId: string }
export type FavoriteModel = FavoriteKey & { addedAt: string }

export interface FavoritesStore {
  /** Sync snapshot for useSyncExternalStore; the same array until a change. */
  list(): readonly FavoriteModel[]
  subscribe(onChange: () => void): () => void
  /** Optimistic: the list changes at once and rolls back if the write fails. */
  set(key: FavoriteKey, on: boolean): Promise<void>
}

/** Where a favorite's data is kept. Each call is idempotent. */
export interface FavoritesAdapter {
  load(): readonly FavoriteModel[]
  put(favorite: FavoriteModel): Promise<void>
  remove(key: FavoriteKey): Promise<void>
  /**
   * Optional: call `onChange` when the data changes from outside this store
   * (another window). Returns the unsubscribe.
   */
  watch?(onChange: () => void): () => void
}

export const FAVORITES_STORAGE_KEY = 'termul.favoriteModels.v1'

/** The backend path for one favorite. */
export function favoritePath(key: FavoriteKey): string {
  return `/me/favorite-models/${encodeURIComponent(key.configId)}/${encodeURIComponent(key.modelId)}`
}

export function favoriteId(key: FavoriteKey): string {
  return `${key.configId}\0${key.modelId}`
}

export function sameFavorite(a: FavoriteKey, b: FavoriteKey): boolean {
  return a.configId === b.configId && a.modelId === b.modelId
}

function isFavorite(value: unknown): value is FavoriteModel {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.configId === 'string' &&
    typeof v.modelId === 'string' &&
    typeof v.addedAt === 'string' &&
    v.configId !== '' &&
    v.modelId !== ''
  )
}

/** Oldest first; ties keep their stored order. */
function byAddedAt(favorites: readonly FavoriteModel[]): FavoriteModel[] {
  return favorites
    .map((favorite, index) => ({ favorite, index }))
    .sort((a, b) => a.favorite.addedAt.localeCompare(b.favorite.addedAt) || a.index - b.index)
    .map(({ favorite }) => favorite)
}

/** Reads a stored list. Anything unreadable is an empty list, never a throw. */
export function parseFavorites(raw: string | null): FavoriteModel[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const items = Array.isArray(parsed) ? parsed : []
    const seen = new Set<string>()
    return items.filter((item): item is FavoriteModel => {
      if (!isFavorite(item)) return false
      const id = favoriteId(item)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  } catch {
    return []
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type StorageEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * The first adapter: one JSON array in localStorage. `events` (the window)
 * delivers `storage` events, which fire when another window writes the key.
 */
export function localStorageAdapter(
  storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage,
  storageKey = FAVORITES_STORAGE_KEY,
  events: StorageEvents | null = typeof window === 'undefined' ? null : window
): FavoritesAdapter {
  const read = (): FavoriteModel[] => {
    try {
      return parseFavorites(storage?.getItem(storageKey) ?? null)
    } catch {
      return []
    }
  }
  const write = (items: readonly FavoriteModel[]): void => {
    if (!storage) throw new Error('No storage for favorites')
    storage.setItem(storageKey, JSON.stringify(items))
  }
  return {
    load: read,
    put: async (favorite) => {
      const items = read()
      if (items.some((item) => sameFavorite(item, favorite))) return
      write([...items, favorite])
    },
    remove: async (key) => {
      const items = read()
      const rest = items.filter((item) => !sameFavorite(item, key))
      if (rest.length !== items.length) write(rest)
    },
    watch: events
      ? (onChange) => {
          const onStorage = (event: StorageEvent): void => {
            // `key` is null when the other window cleared the whole storage.
            if (event.key !== null && event.key !== storageKey) return
            if (event.storageArea && event.storageArea !== storage) return
            onChange()
          }
          events.addEventListener('storage', onStorage)
          return () => events.removeEventListener('storage', onStorage)
        }
      : undefined
  }
}

/** An in-memory adapter: tests and the design canvas (no shared storage). */
export function memoryFavoritesAdapter(seed: readonly FavoriteModel[] = []): FavoritesAdapter {
  let raw: string | null = JSON.stringify(seed)
  return localStorageAdapter(
    {
      getItem: () => raw,
      setItem: (_key, value) => {
        raw = value
      }
    },
    FAVORITES_STORAGE_KEY,
    null
  )
}

/**
 * The store over any adapter. Writes are optimistic and per key
 * last-write-wins: a failed write rolls its key back to the last state the
 * adapter confirmed, unless a newer write for that key has since started.
 * Mirrors `useOptimisticSwitch` (flip now, revert on rejection).
 *
 * While anything is subscribed it also watches the adapter, so a change
 * made in another window shows here without a reload. The watch starts with
 * the first subscriber and stops with the last.
 */
export function createFavoritesStore(
  adapter: FavoritesAdapter,
  now: () => Date = () => new Date()
): FavoritesStore {
  let items: readonly FavoriteModel[] = byAddedAt(adapter.load())
  /** Per key: the adapter-confirmed entry, or null when confirmed absent. */
  const confirmed = new Map<string, FavoriteModel | null>()
  const latest = new Map<string, number>()
  const listeners = new Set<() => void>()
  let seq = 0
  let unwatch: (() => void) | null = null

  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const find = (key: FavoriteKey): FavoriteModel | null =>
    items.find((item) => sameFavorite(item, key)) ?? null
  /**
   * Re-read the adapter after an outside change. A key with a write in
   * flight keeps its optimistic value, and a rollback now returns to what
   * the other window stored.
   */
  const reload = (): void => {
    const loaded = byAddedAt(adapter.load())
    const pending = (item: FavoriteKey): boolean => latest.has(favoriteId(item))
    for (const id of latest.keys()) {
      confirmed.set(id, loaded.find((item) => favoriteId(item) === id) ?? null)
    }
    const next = byAddedAt([...loaded.filter((item) => !pending(item)), ...items.filter(pending)])
    if (JSON.stringify(next) === JSON.stringify(items)) return
    items = next
    emit()
  }
  const replace = (key: FavoriteKey, next: FavoriteModel | null): void => {
    const rest = items.filter((item) => !sameFavorite(item, key))
    items = byAddedAt(next ? [...rest, next] : rest)
    emit()
  }

  return {
    list: () => items,
    subscribe: (onChange) => {
      listeners.add(onChange)
      if (!unwatch && adapter.watch) {
        unwatch = adapter.watch(reload)
        // Unwatched until now: pick up anything another window wrote meanwhile.
        reload()
      }
      return () => {
        listeners.delete(onChange)
        if (listeners.size === 0 && unwatch) {
          unwatch()
          unwatch = null
        }
      }
    },
    set: async (key, on) => {
      const id = favoriteId(key)
      const current = find(key)
      // Idempotent: on twice keeps the first addedAt; off on a missing key is a no-op.
      if (on ? current : !current) return
      if (!confirmed.has(id)) confirmed.set(id, current)
      const next = on ? { ...key, addedAt: now().toISOString() } : null
      const mine = ++seq
      latest.set(id, mine)
      replace(key, next)
      try {
        if (next) await adapter.put(next)
        else await adapter.remove(key)
        // The adapter now holds this write, whichever write is newest.
        if (latest.has(id)) confirmed.set(id, next)
      } catch (error) {
        if (latest.get(id) === mine) replace(key, confirmed.get(id) ?? null)
        throw error
      } finally {
        if (latest.get(id) === mine) {
          latest.delete(id)
          confirmed.delete(id)
        }
      }
    }
  }
}

let appStore: FavoritesStore | null = null

/** The app's store, made on first use. */
export function appFavoritesStore(): FavoritesStore {
  appStore ??= createFavoritesStore(localStorageAdapter())
  return appStore
}

/** Overrides the app store (the canvas seeds its own). */
export const FavoritesStoreContext = createContext<FavoritesStore | null>(null)

export function useFavoritesStore(): FavoritesStore {
  return useContext(FavoritesStoreContext) ?? appFavoritesStore()
}

/** The live list, oldest first. */
export function useFavoriteModels(store: FavoritesStore): readonly FavoriteModel[] {
  return useSyncExternalStore(store.subscribe, store.list, store.list)
}
