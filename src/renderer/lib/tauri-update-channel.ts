import { Store } from '@tauri-apps/plugin-store'

import {
  DEFAULT_UPDATE_CHANNEL,
  normalizeUpdateChannel,
  type UpdateChannel
} from './tauri-updater-api'

// Reuses the same `updater-preferences.json` store file as the version-skip
// preference so all updater preferences live in one place. The channel
// preference selects which per-channel manifest `checkForUpdates` consults.
const STORE_FILE = 'updater-preferences.json'
const UPDATE_CHANNEL_KEY = 'updater.updateChannel'

let storeInstance: Store | null = null

async function getStore(): Promise<Store> {
  if (storeInstance) return storeInstance

  storeInstance = await Store.load(STORE_FILE, {
    autoSave: false,
    defaults: {}
  })

  return storeInstance
}

/**
 * Load the persisted update channel preference. Returns the default
 * (`stable`) when unset or when the stored value is not a recognized channel.
 */
export async function getUpdateChannel(): Promise<UpdateChannel> {
  const store = await getStore()
  const value = await store.get<string>(UPDATE_CHANNEL_KEY)
  return normalizeUpdateChannel(value)
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  const store = await getStore()
  await store.set(UPDATE_CHANNEL_KEY, channel)
  await store.save()
}

export function _resetUpdateChannelStoreForTesting(): void {
  storeInstance = null
}

export type { UpdateChannel }
export { DEFAULT_UPDATE_CHANNEL }
