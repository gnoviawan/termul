/**
 * Thin Tauri core invoke facade for modules that still need raw commands
 * (Story 1.6 Biome ban). Prefer domain facades when available.
 */
export { invoke } from '@tauri-apps/api/core'
