/**
 * Codex streams command output on tool-call `_meta`, not inside the
 * `terminal` content block. Each update carries one chunk. The client appends
 * chunks and keeps the exit code.
 */

export interface TerminalStreamFields {
  terminalOutput?: string
  terminalExitCode?: number | null
}

const MAX_TERMINAL_OUTPUT_CHARS = 64 * 1024
const TERMINAL_TRUNCATION_MARKER = '\n[termul: tool call content truncated]'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Append one Codex terminal chunk onto the stored tool call. */
export function applyTerminalStream(
  previous: object | undefined,
  incoming: object
): TerminalStreamFields {
  const prior = asRecord(previous)
  const next = asRecord(incoming)
  let output = typeof prior?.terminalOutput === 'string' ? prior.terminalOutput : ''
  let exitCode = typeof prior?.terminalExitCode === 'number' ? prior.terminalExitCode : undefined
  const meta = asRecord(next?._meta)
  const delta = asRecord(meta?.terminal_output_delta)
  if (typeof delta?.data === 'string' && delta.data.length > 0) {
    const room = MAX_TERMINAL_OUTPUT_CHARS - output.length
    if (room > 0) {
      if (delta.data.length <= room) output += delta.data
      else
        output +=
          delta.data.slice(0, Math.max(0, room - TERMINAL_TRUNCATION_MARKER.length)) +
          TERMINAL_TRUNCATION_MARKER
    }
  }
  const exit = asRecord(meta?.terminal_exit)
  if (typeof exit?.exit_code === 'number' && Number.isFinite(exit.exit_code)) {
    exitCode = exit.exit_code
  }
  return {
    ...(output.length > 0 ? { terminalOutput: output } : {}),
    ...(exitCode !== undefined ? { terminalExitCode: exitCode } : {})
  }
}
