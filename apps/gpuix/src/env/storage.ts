/**
 * Web `Storage` for a Bun process. `FileStorage` is `localStorage`: one JSON
 * file per server origin, written atomically a moment after the last change
 * and on exit. `MemoryStorage` is `sessionStorage`: it lives as long as the
 * process, like a browser tab.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const WRITE_DELAY_MS = 150

export class MemoryStorage implements Storage {
  protected readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
    this.changed()
  }

  removeItem(key: string): void {
    if (this.items.delete(key)) this.changed()
  }

  clear(): void {
    if (this.items.size === 0) return
    this.items.clear()
    this.changed()
  }

  protected changed(): void {}
}

export class FileStorage extends MemoryStorage {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(readonly file: string) {
    super()
    this.load()
    process.on('exit', () => this.flush())
  }

  private load(): void {
    if (!existsSync(this.file)) return
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.file} is not a JSON object`)
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') this.items.set(key, value)
    }
  }

  protected override changed(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, WRITE_DELAY_MS)
  }

  /** Write the file now if anything changed since the last write. */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.items), null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
