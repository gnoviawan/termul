import { useSyncExternalStore } from 'react'
import { serverPathsCaseInsensitive, subscribeServerCapability } from '@/lib/tauri-runtime'

export function useServerPathsCaseInsensitive(): boolean {
  return useSyncExternalStore(subscribeServerCapability, serverPathsCaseInsensitive)
}
