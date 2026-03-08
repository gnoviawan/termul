import { Store } from '@tauri-apps/plugin-store';
import type { IpcResult } from '@shared/types/ipc.types';

const STORE_FILE = 'termul-data.json';
const DEBOUNCE_MS = 500;
const CURRENT_VERSION = 1;

interface PersistedStore<T> {
  _version: number;
  data: T;
}

let storeInstance: Store | null = null;
const pendingDebounce = new Map<string, ReturnType<typeof setTimeout>>();

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(STORE_FILE, { autoSave: false, defaults: {} });
  }
  return storeInstance;
}

export const tauriPersistenceApi = {
  async read<T>(key: string): Promise<IpcResult<T>> {
    try {
      const store = await getStore();
      const raw = await store.get<PersistedStore<T> | T>(key);

      if (raw === null || raw === undefined) {
        return { success: false, error: `Key not found: ${key}`, code: 'KEY_NOT_FOUND' };
      }

      // Handle versioned data
      if (typeof raw === 'object' && raw !== null && '_version' in raw) {
        const versioned = raw as PersistedStore<T>;
        return { success: true, data: versioned.data };
      }

      // Legacy data without version
      return { success: true, data: raw as T };
    } catch (err) {
      return { success: false, error: String(err), code: 'READ_ERROR' };
    }
  },

  async write<T>(key: string, data: T): Promise<IpcResult<void>> {
    try {
      const store = await getStore();
      const versioned: PersistedStore<T> = { _version: CURRENT_VERSION, data };
      await store.set(key, versioned);
      await store.save();
      return { success: true, data: undefined };
    } catch (err) {
      return { success: false, error: String(err), code: 'WRITE_ERROR' };
    }
  },

  async writeDebounced<T>(key: string, data: T): Promise<IpcResult<void>> {
    const existing = pendingDebounce.get(key);
    if (existing) clearTimeout(existing);

    return new Promise((resolve) => {
      pendingDebounce.set(key, setTimeout(async () => {
        const result = await tauriPersistenceApi.write(key, data);
        pendingDebounce.delete(key);
        resolve(result);
      }, DEBOUNCE_MS));
    });
  },

  async remove(key: string): Promise<IpcResult<void>> {
    try {
      const store = await getStore();
      await store.delete(key);
      await store.save();
      return { success: true, data: undefined };
    } catch (err) {
      return { success: false, error: String(err), code: 'DELETE_ERROR' };
    }
  },

  // Alias for remove - matches PersistenceApi interface
  async delete(key: string): Promise<IpcResult<void>> {
    return this.remove(key);
  },

  async flushPendingWrites(): Promise<void> {
    for (const timer of pendingDebounce.values()) {
      clearTimeout(timer);
    }
    pendingDebounce.clear();
    const store = await getStore();
    await store.save();
  },
};

/**
 * Factory function for consistency with other APIs
 */
export function createTauriPersistenceApi() {
  return tauriPersistenceApi;
}

/**
 * @internal Testing only - reset the singleton store instance
 */
export function _resetStoreInstanceForTesting() {
  storeInstance = null;
  pendingDebounce.clear();
}
