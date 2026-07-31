/**
 * Browser stub for `@tauri-apps/plugin-store`.
 * No persistent store in the web build — load returns an empty in-memory shim.
 */
export class Store {
  static async load(_path: string, _options?: unknown): Promise<Store> {
    return new Store()
  }

  async get<T>(_key: string): Promise<T | undefined> {
    return undefined
  }

  async set(_key: string, _value: unknown): Promise<void> {}

  async save(): Promise<void> {}

  async delete(_key: string): Promise<void> {}

  async clear(): Promise<void> {}

  async reset(): Promise<void> {}

  async keys(): Promise<string[]> {
    return []
  }

  async values<T>(): Promise<T[]> {
    return []
  }

  async entries<T>(): Promise<[string, T][]> {
    return []
  }

  async length(): Promise<number> {
    return 0
  }

  async has(_key: string): Promise<boolean> {
    return false
  }
}
