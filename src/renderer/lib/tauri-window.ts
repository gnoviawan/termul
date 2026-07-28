/**
 * Thin Tauri window facade — components/hooks import window APIs from here
 * (Story 1.6 Biome ban), not from `@tauri-apps/api/window` directly.
 */
export {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  type Monitor,
  primaryMonitor
} from '@tauri-apps/api/window'
