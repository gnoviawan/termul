import type { Terminal } from '@xterm/xterm'
import { DEFAULT_SCROLLBACK_LIMIT } from '../../shared/types/persistence.types'

/**
 * Registry to track xterm Terminal instances by terminal ID
 * This allows the auto-save hook to access terminal buffers for scrollback persistence
 */
const terminalRegistry = new Map<string, Terminal>()

/**
 * Cache for scroll positions during pane transitions
 * Maps terminal ID to scroll position (viewportY offset from buffer base)
 */
const scrollPositionCache = new Map<string, number>()

/**
 * Register a terminal instance for scrollback persistence
 */
export function registerTerminal(terminalId: string, terminal: Terminal): void {
  terminalRegistry.set(terminalId, terminal)
}

/**
 * Unregister a terminal when it's disposed
 */
export function unregisterTerminal(terminalId: string): void {
  terminalRegistry.delete(terminalId)
}

/**
 * Get a terminal instance by ID
 */
export function getTerminal(terminalId: string): Terminal | undefined {
  return terminalRegistry.get(terminalId)
}

/**
 * Extract scrollback content from a terminal's buffer
 * Returns array of lines with ANSI escape sequences preserved
 */
export function extractScrollback(
  terminalId: string,
  maxLines: number = DEFAULT_SCROLLBACK_LIMIT
): string[] | undefined {
  const terminal = terminalRegistry.get(terminalId)
  if (!terminal) return undefined

  const buffer = terminal.buffer.active
  const lines: string[] = []

  // Get total lines (scrollback + viewport)
  const totalLines = buffer.length

  // Calculate start line to respect maxLines limit
  const startLine = Math.max(0, totalLines - maxLines)

  for (let i = startLine; i < totalLines; i++) {
    const line = buffer.getLine(i)
    if (line) {
      // translateToString(trimRight=false) preserves trailing whitespace and ANSI sequences
      lines.push(line.translateToString(false))
    }
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }

  return lines.length > 0 ? lines : undefined
}

/**
 * Restore scrollback content to a terminal
 * Writes each line followed by newline to recreate the output
 */
export function restoreScrollback(terminal: Terminal, scrollback: string[]): void {
  if (!scrollback || scrollback.length === 0) return

  try {
    // Join lines with newlines and write to terminal
    // This restores the visual content without executing commands
    const content = scrollback.join('\r\n') + '\r\n'
    terminal.write(content)
  } catch (err) {
    console.error('Failed to restore scrollback:', err)
  }
}

/**
 * Get count of registered terminals (for testing)
 */
export function getRegistrySize(): number {
  return terminalRegistry.size
}

/**
 * Clear all registered terminals (for testing)
 */
export function clearRegistry(): void {
  terminalRegistry.clear()
  scrollPositionCache.clear()
}

/**
 * Capture the current scroll position of a terminal before unmount
 * Stores the viewportY position for restoration after remount
 */
export function captureScrollPosition(terminalId: string): void {
  const terminal = terminalRegistry.get(terminalId)
  if (terminal && terminal.buffer?.active) {
    const viewportY = terminal.buffer.active.viewportY
    scrollPositionCache.set(terminalId, viewportY)
  }
}

/**
 * Get cached scroll position for a terminal
 * Returns undefined if no cached position exists
 */
export function getCachedScrollPosition(terminalId: string): number | undefined {
  return scrollPositionCache.get(terminalId)
}

/**
 * Clear cached scroll position for a terminal
 * Call after successful restoration to prevent stale data
 */
export function clearScrollPosition(terminalId: string): void {
  scrollPositionCache.delete(terminalId)
}

/**
 * Restore scroll position to a terminal
 * Scrolls the terminal to the cached position if available
 * Returns true if restoration was performed, false otherwise
 */
export function restoreScrollPosition(terminalId: string, terminal: Terminal): boolean {
  const cachedPosition = scrollPositionCache.get(terminalId)
  if (cachedPosition !== undefined && terminal.scrollToLine) {
    // Use scrollToLine to restore position
    // The buffer line index is calculated from the base
    try {
      terminal.scrollToLine(cachedPosition)
      // Clear cache after successful restoration
      scrollPositionCache.delete(terminalId)
      return true
    } catch {
      // Clear cache on error to prevent stale data
      scrollPositionCache.delete(terminalId)
      return false
    }
  }
  return false
}
