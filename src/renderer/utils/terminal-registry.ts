import type { Terminal } from '@xterm/xterm'
import { DEFAULT_SCROLLBACK_LIMIT } from '../../shared/types/persistence.types'

/**
 * Registry to track xterm Terminal instances by terminal ID
 * This allows the auto-save hook to access terminal buffers for scrollback persistence
 */
const terminalRegistry = new Map<string, Terminal>()

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
}
