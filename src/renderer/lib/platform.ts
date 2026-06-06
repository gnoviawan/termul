/**
 * Platform detection helpers for OS-aware behavior.
 *
 * Centralises every platform check so the rest of the codebase can import
 * a single source of truth instead of repeating `navigator.platform` checks.
 */

/** Cached platform string (lower-cased). */
const _platform: string = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : ''

/** True when running on macOS / Darwin. */
export const isMac: boolean = _platform.includes('mac')

/**
 * Slim top inset for macOS overlay title bar / traffic-light clearance.
 * Used as a single full-width drag strip above the workspace chrome.
 */
export const macOsTitlebarStripClass = 'h-6 shrink-0'

/** True when running on Windows. */
export const isWindows: boolean = _platform.includes('win')

/** True when running on Linux / other Unix. */
export const isLinux: boolean = !_platform.includes('mac') && !_platform.includes('win')

/**
 * The *primary* modifier key used for app shortcuts on the current OS.
 *
 * - macOS → `"cmd"`  (⌘ / metaKey)
 * - Windows / Linux → `"ctrl"` (ctrlKey)
 */
export function getPlatformModifier(): 'cmd' | 'ctrl' {
  return isMac ? 'cmd' : 'ctrl'
}

/**
 * Returns `true` when the event's primary modifier is active.
 *
 * On macOS this checks `metaKey` (⌘), everywhere else `ctrlKey`.
 */
export function isPlatformModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/**
 * Returns `true` when the *secondary* modifier is active.
 *
 * On macOS this is `ctrlKey`, everywhere else `metaKey`.
 * Useful for shortcuts that intentionally differ per OS.
 */
export function isSecondaryModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.ctrlKey : e.metaKey
}
