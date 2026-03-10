import { Store } from '@tauri-apps/plugin-store'
import type { IpcResult } from '@shared/types/ipc.types'

const STORE_FILE = 'termul-data.json'
const DEBOUNCE_MS = 500
const CURRENT_VERSION = 1

interface PersistedStore<T> {
  _version: number
  data: T
}

type PendingWriteResolver = (result: IpcResult<void>) => void

interface PendingDebounceEntry<T = unknown> {
  timer: ReturnType<typeof setTimeout> | null
  data: T
  resolvers: PendingWriteResolver[]
  activeWrite: Promise<IpcResult<void>> | null
}

let storeInstance: Store | null = null
const pendingDebounce = new Map<string, PendingDebounceEntry>()

function createSuccessResult(): IpcResult<void> {
  return { success: true, data: undefined }
}

function resolvePendingResolvers(
  resolvers: PendingWriteResolver[],
  result: IpcResult<void>
): void {
  resolvers.forEach((resolve) => resolve(result))
}

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(STORE_FILE, { autoSave: false, defaults: {} })
  }
  return storeInstance
}

async function persistVersionedData<T>(key: string, data: T): Promise<IpcResult<void>> {
  try {
    const store = await getStore()
    const versioned: PersistedStore<T> = { _version: CURRENT_VERSION, data }
    await store.set(key, versioned)
    await store.save()
    return createSuccessResult()
  } catch (err) {
    return { success: false, error: String(err), code: 'WRITE_ERROR' }
  }
}

function schedulePendingWrite(key: string, entry: PendingDebounceEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  entry.timer = setTimeout(() => {
    entry.timer = null
    void flushPendingEntry(key, entry)
  }, DEBOUNCE_MS)
}

async function flushPendingEntry(
  key: string,
  entry: PendingDebounceEntry
): Promise<IpcResult<void>> {
  if (entry.activeWrite) {
    const activeWriteResult = await entry.activeWrite

    if (entry.resolvers.length === 0) {
      if (entry.timer === null) {
        pendingDebounce.delete(key)
      }

      return activeWriteResult
    }
  }

  if (entry.resolvers.length === 0) {
    if (entry.timer === null && entry.activeWrite === null) {
      pendingDebounce.delete(key)
    }

    return createSuccessResult()
  }

  const dataToWrite = entry.data
  const resolvers = [...entry.resolvers]
  entry.resolvers = []

  const writePromise = persistVersionedData(key, dataToWrite)
    .then((result) => {
      resolvePendingResolvers(resolvers, result)
      return result
    })
    .finally(() => {
      entry.activeWrite = null

      if (entry.resolvers.length === 0 && entry.timer === null) {
        pendingDebounce.delete(key)
      }
    })

  entry.activeWrite = writePromise
  return writePromise
}

export const tauriPersistenceApi = {
  async read<T>(key: string): Promise<IpcResult<T>> {
    try {
      const store = await getStore()
      const raw = await store.get<PersistedStore<T> | T>(key)

      if (raw === null || raw === undefined) {
        return { success: false, error: `Key not found: ${key}`, code: 'KEY_NOT_FOUND' }
      }

      // Handle versioned data
      if (typeof raw === 'object' && raw !== null && '_version' in raw) {
        const versioned = raw as PersistedStore<T>
        return { success: true, data: versioned.data }
      }

      // Legacy data without version
      return { success: true, data: raw as T }
    } catch (err) {
      return { success: false, error: String(err), code: 'READ_ERROR' }
    }
  },

  async write<T>(key: string, data: T): Promise<IpcResult<void>> {
    return persistVersionedData(key, data)
  },

  async writeDebounced<T>(key: string, data: T): Promise<IpcResult<void>> {
    return new Promise((resolve) => {
      const existing = pendingDebounce.get(key)

      if (existing) {
        existing.data = data
        existing.resolvers.push(resolve)
        schedulePendingWrite(key, existing)
        return
      }

      const entry: PendingDebounceEntry<T> = {
        timer: null,
        data,
        resolvers: [resolve],
        activeWrite: null
      }

      pendingDebounce.set(key, entry)
      schedulePendingWrite(key, entry)
    })
  },

  async remove(key: string): Promise<IpcResult<void>> {
    try {
      const store = await getStore()
      await store.delete(key)
      await store.save()
      return createSuccessResult()
    } catch (err) {
      return { success: false, error: String(err), code: 'DELETE_ERROR' }
    }
  },

  // Alias for remove - matches PersistenceApi interface
  async delete(key: string): Promise<IpcResult<void>> {
    return this.remove(key)
  },

  async flushPendingWrites(): Promise<IpcResult<void>> {
    let firstFailure: IpcResult<void> | null = null

    for (const [key, entry] of Array.from(pendingDebounce.entries())) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }

      const result = await flushPendingEntry(key, entry)
      if (!result.success && firstFailure === null) {
        firstFailure = result
      }
    }

    return firstFailure ?? createSuccessResult()
  }
}

/**
 * Factory function for consistency with other APIs
 */
export function createTauriPersistenceApi() {
  return tauriPersistenceApi
}

/**
 * @internal Testing only - reset the singleton store instance
 */
export function _resetStoreInstanceForTesting() {
  storeInstance = null

  for (const entry of pendingDebounce.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
  }

  pendingDebounce.clear()
}
