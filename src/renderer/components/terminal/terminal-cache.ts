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

import { Terminal } from "@xterm/xterm";

/** Map of PTY ID → cached Terminal instance. */
const cache = new Map<string, Terminal>();

/** Maximum number of cached terminal instances. Oldest entries are evicted first. */
const MAX_CACHE_SIZE = 10;

/**
 * Store a terminal in the cache and detach its DOM element.
 * Call this in the cleanup (unmount) path instead of terminal.dispose().
 *
 * Enforces a max cache size via LRU eviction — the oldest cached terminal
 * is disposed and removed when the limit is reached.
 */
export function cacheTerminal(ptyId: string, terminal: Terminal): void {
	if (cache.has(ptyId)) {
		// Already cached — shouldn't happen, but avoid double-cache
		return;
	}

	// Evict oldest entry if cache is full
	if (cache.size >= MAX_CACHE_SIZE) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey !== undefined) {
			const oldest = cache.get(oldestKey);
			if (oldest) {
				oldest.dispose();
			}
			cache.delete(oldestKey);
		}
	}

	// Detach the xterm element from the DOM so it doesn't linger in the
	// old container. The element is preserved for reattachment later.
	terminal.element?.remove();

	cache.set(ptyId, terminal);
}

/**
 * Retrieve and remove a cached terminal.
 * Returns undefined if no cached terminal exists for this PTY ID.
 * The caller is responsible for reattaching the element via:
 *   container.appendChild(terminal.element!)
 */
export function takeCachedTerminal(ptyId: string): Terminal | undefined {
	const terminal = cache.get(ptyId);
	if (terminal) {
		cache.delete(ptyId);
	}
	return terminal;
}

/**
 * Check if a terminal is in the cache without removing it.
 */
export function hasCachedTerminal(ptyId: string): boolean {
	return cache.has(ptyId);
}

/**
 * Clear all cached terminals — useful for testing or app-wide cleanup.
 */
export function clearTerminalCache(): void {
	cache.clear();
}
