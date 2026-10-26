import { Store } from '@tauri-apps/plugin-store'
import { getDesktopHost } from './desktop-host'
import { LocalPluginStore } from './local-plugin-store'

const STORE_FILE = 'updater-preferences.json'
const SKIPPED_VERSION_KEY = 'updater.skippedVersion'

let storeInstance: Store | LocalPluginStore | null = null

async function getStore(): Promise<Store | LocalPluginStore> {
  if (storeInstance) return storeInstance

  // A desktop host (GPUIX) has no Tauri store: it keeps the preference with the device.
  storeInstance = getDesktopHost()
    ? new LocalPluginStore(STORE_FILE)
    : await Store.load(STORE_FILE, {
        autoSave: false,
        defaults: {}
      })

  return storeInstance
}

export async function getSkippedVersion(): Promise<string | null> {
  const store = await getStore()
  const value = await store.get<string>(SKIPPED_VERSION_KEY)
  return value ?? null
}

export async function skipVersion(version: string): Promise<void> {
  const store = await getStore()
  await store.set(SKIPPED_VERSION_KEY, version)
  await store.save()
}

export async function clearSkippedVersion(): Promise<void> {
  const store = await getStore()
  await store.delete(SKIPPED_VERSION_KEY)
  await store.save()
}

export async function isVersionSkipped(version: string): Promise<boolean> {
  const skippedVersion = await getSkippedVersion()
  return skippedVersion === version
}

export function _resetVersionSkipStoreForTesting(): void {
  storeInstance = null
}
