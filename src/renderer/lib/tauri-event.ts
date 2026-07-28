/**
 * Thin Tauri event facade — components/hooks must import `listen` from here
 * (Story 1.6 Biome ban), not from `@tauri-apps/api/event` directly.
 */
export { type Event, listen, type UnlistenFn } from '@tauri-apps/api/event'
