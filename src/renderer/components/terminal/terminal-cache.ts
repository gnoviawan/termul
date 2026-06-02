/**
 * Terminal Cache
 *
 * Keeps xterm Terminal instances alive across project switches by caching
 * them in memory instead of calling terminal.dispose() on unmount.
 *
 * Without this, terminal.dispose() destroys ALL terminal state (scrollback,
 * alt buffer, cursor position). The transcript replay mechanism can only
 * partially reconstruct it, producing garbled/truncated output — especially
 * for TUI apps running in the alt buffer.
 *
 * Usage:
 *   On unmount:  cacheTerminal(ptyId, terminal)
 *   On remount:  takeCachedTerminal(ptyId) → Terminal | undefined
 */

import type { Terminal } from '@xterm/xterm'

/** Map of PTY ID → cached Terminal instance. */
const cache = new Map<string, Terminal>()

/**
 * Store a terminal in the cache and detach its DOM element.
 * Call this in the cleanup (unmount) path instead of terminal.dispose().
 *
 * If a terminal is already cached for the same PTY ID (which can happen
 * during rapid project switches A -> B -> A -> B where React schedules
 * effects across two renders), we dispose the previous occupant before
 * caching the new one. Without this, the older xterm instance leaks and
 * its detached element keeps event listeners alive that can starve the
 * live renderer of focus / keystrokes — visible to users as "terminal
 * freezes after rapid switching".
 */
export function cacheTerminal(ptyId: string, terminal: Terminal): void {
  const existing = cache.get(ptyId)
  if (existing && existing !== terminal) {
    // Different instance already cached for this PTY — dispose the old
    // one to release its WebGL context, addons, and DOM node.
    try {
      existing.dispose()
    } catch {
      // Already disposed in some other path — ignore.
    }
    cache.delete(ptyId)
  } else if (existing === terminal) {
    // Same instance re-cached — only ensure DOM is detached.
    terminal.element?.remove()
    return
  }

  // Detach the xterm element from the DOM so it doesn't linger in the
  // old container. The element is preserved for reattachment later.
  terminal.element?.remove()

  cache.set(ptyId, terminal)
}

/**
 * Retrieve and remove a cached terminal.
 * Returns undefined if no cached terminal exists for this PTY ID.
 * The caller is responsible for reattaching the element via:
 *   container.appendChild(terminal.element!)
 */
export function takeCachedTerminal(ptyId: string): Terminal | undefined {
  const terminal = cache.get(ptyId)
  if (terminal) {
    cache.delete(ptyId)
  }
  return terminal
}

/**
 * Check if a terminal is in the cache without removing it.
 */
export function hasCachedTerminal(ptyId: string): boolean {
  return cache.has(ptyId)
}

/**
 * Clear all cached terminals — useful for testing or app-wide cleanup.
 */
export function clearTerminalCache(): void {
  cache.clear()
}
