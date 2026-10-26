/**
 * A localStorage-backed stand-in for the Tauri plugin-store `Store`, for the
 * roots without Tauri (the browser, and the GPUIX client's desktop host).
 * Each logical key is its own localStorage entry, `${file}::${key}`, holding
 * JSON (e.g. `whats-new.json::whatsNew.lastSeenVersion`); there is no shared
 * envelope object.
 *
 * `save()` is a no-op: localStorage writes are synchronous, so `set` already
 * persisted. Every op swallows `QuotaExceededError`/`SecurityError`/JSON
 * parse failures: the callers are best-effort preferences that must never
 * throw on persistence.
 */
export class LocalPluginStore {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  private compositeKey(key: string): string {
    return `${this.file}::${key}`
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (typeof localStorage === 'undefined') return undefined
    try {
      const raw = localStorage.getItem(this.compositeKey(key))
      if (raw === null) return undefined
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(this.compositeKey(key), JSON.stringify(value))
    } catch {
      // Quota or private mode: drop the write; reads return the last good value.
    }
  }

  async delete(key: string): Promise<boolean> {
    if (typeof localStorage === 'undefined') return false
    try {
      const had = localStorage.getItem(this.compositeKey(key)) !== null
      localStorage.removeItem(this.compositeKey(key))
      return had
    } catch {
      return false
    }
  }

  async save(): Promise<void> {}
}
