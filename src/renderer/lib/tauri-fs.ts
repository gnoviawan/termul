/**
 * Thin fs re-exports for components (Story 1.6 Biome ban).
 * Prefer `filesystemApi` / `tauri-filesystem-api` for new call sites.
 */
export { readDir, readTextFile, writeFile } from '@tauri-apps/plugin-fs'
