/**
 * Browser stub for `@tauri-apps/plugin-store`.
 *
 * Web build only — aliased in by `vite.config.web.ts`. Backs the prior no-op
 * stub with `localStorage` so persistence (`persistenceApi`, editor layout,
 * projects, app settings, context-bar, terminal autosave, etc.) actually
 * round-trips on a web reload. Desktop uses the real Tauri plugin-store.
 *
 * - `load(path)` returns a Store namespaced by `path` so distinct stores never
 *   bleed into each other.
 * - `set` writes immediately (JSON-serialized); `save()` is a no-op (the web
 *   build has no deferred disk flush — data is already in `localStorage`).
 * - All ops catch `QuotaExceededError` / `SecurityError` / JSON parse failures
 *   and degrade silently (return `undefined` / empty, never throw to the UI).
 * - Guards `typeof localStorage` for SSR / non-browser hosts.
 *
 * The class shape and method signatures are preserved so every existing
 * consumer unblocks without per-consumer edits.
 */
const STORAGE_PREFIX = 'termul-store:'

/** Escape `:` in a namespace so a namespace containing `::` (e.g. `a::b`)
 * can't make `clear('a')` prefix-match into `a::b`'s keys. Keys are NOT
 * escaped — they sit after the delimiter and may contain anything; `keys()`
 * already slices the prefix, so escaping only the namespace preserves key
 * values. Uses a control char (\u0001) that can't appear in a store path. */
function escapeNamespace(namespace: string): string {
  return namespace.replaceAll(':', '\u0001')
}

function storageKey(namespace: string, key: string): string {
  return `${STORAGE_PREFIX}${escapeNamespace(namespace)}::${key}`
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export class Store {
  private readonly namespace: string
  /** Defaults passed to `load()` — re-applied by `reset()` (Tauri parity). */
  private readonly defaults: Record<string, unknown>

  private constructor(namespace: string, defaults: Record<string, unknown>) {
    this.namespace = namespace
    this.defaults = defaults
  }

  static async load(path: string, options?: unknown): Promise<Store> {
    // Tauri-faithful: `defaults` pre-populate keys that are absent on load. The
    // only current caller passes an empty `defaults` (a no-op), but apply the
    // semantics so the contract holds for any future caller.
    const rawDefaults = (options as { defaults?: Record<string, unknown> } | null | undefined)
      ?.defaults
    const defaults: Record<string, unknown> =
      rawDefaults && typeof rawDefaults === 'object' ? rawDefaults : {}
    const store = new Store(path, defaults)
    for (const [key, value] of Object.entries(defaults)) {
      if (!(await store.has(key))) {
        await store.set(key, value)
      }
    }
    return store
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!hasLocalStorage()) return undefined
    try {
      const raw = localStorage.getItem(storageKey(this.namespace, key))
      if (raw == null) return undefined
      return JSON.parse(raw) as T
    } catch {
      // Corrupt JSON / SecurityError (private mode) — degrade silently.
      return undefined
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!hasLocalStorage()) return
    try {
      localStorage.setItem(storageKey(this.namespace, key), JSON.stringify(value))
    } catch {
      // QuotaExceededError / SecurityError — drop the write silently. The UI
      // must never throw on persistence; reads return last-good or empty.
    }
  }

  async save(): Promise<void> {
    // No-op: `set` writes immediately to localStorage (no deferred disk flush
    // in the web build).
  }

  async delete(key: string): Promise<void> {
    if (!hasLocalStorage()) return
    try {
      localStorage.removeItem(storageKey(this.namespace, key))
    } catch {
      // degrade silently
    }
  }

  async clear(): Promise<void> {
    if (!hasLocalStorage()) return
    try {
      const prefix = `${STORAGE_PREFIX}${escapeNamespace(this.namespace)}::`
      // Collect first, then remove — mutating `localStorage` while iterating by
      // index would shift indices and skip entries.
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const stored = localStorage.key(i) ?? ''
        if (stored.startsWith(prefix)) toRemove.push(stored)
      }
      for (const k of toRemove) localStorage.removeItem(k)
    } catch {
      // degrade silently
    }
  }

  async reset(): Promise<void> {
    await this.clear()
    // Tauri-faithful parity: real `Store.reset()` clears AND re-applies the
    // `defaults` passed to `load()`. Without this, reset()-returns-defaults
    // callers silently diverge from desktop.
    for (const [key, value] of Object.entries(this.defaults)) {
      if (!(await this.has(key))) {
        await this.set(key, value)
      }
    }
  }

  async keys(): Promise<string[]> {
    if (!hasLocalStorage()) return []
    try {
      const prefix = `${STORAGE_PREFIX}${escapeNamespace(this.namespace)}::`
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const stored = localStorage.key(i) ?? ''
        if (stored.startsWith(prefix)) keys.push(stored.slice(prefix.length))
      }
      return keys
    } catch {
      return []
    }
  }

  async values<T>(): Promise<T[]> {
    const keys = await this.keys()
    const out: T[] = []
    for (const key of keys) {
      const v = await this.get<T>(key)
      if (v !== undefined) out.push(v)
    }
    return out
  }

  async entries<T>(): Promise<[string, T][]> {
    const keys = await this.keys()
    const out: [string, T][] = []
    for (const key of keys) {
      const v = await this.get<T>(key)
      if (v !== undefined) out.push([key, v])
    }
    return out
  }

  async length(): Promise<number> {
    return (await this.keys()).length
  }

  async has(key: string): Promise<boolean> {
    if (!hasLocalStorage()) return false
    try {
      return localStorage.getItem(storageKey(this.namespace, key)) != null
    } catch {
      return false
    }
  }
}
