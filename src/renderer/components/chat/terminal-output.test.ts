import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import { applyTerminalStream } from './terminal-output'

function call(meta: Record<string, unknown>): ToolCall {
  return { toolCallId: 't1', _meta: meta }
}

describe('applyTerminalStream', () => {
  it('appends output chunks and keeps the exit code', () => {
    const first = applyTerminalStream(
      undefined,
      call({
        terminal_output_delta: { terminal_id: 't1', data: 'hello' }
      })
    )
    expect(first.terminalOutput).toBe('hello')
    const second = applyTerminalStream(
      first,
      call({
        terminal_output_delta: { terminal_id: 't1', data: ' world' },
        terminal_exit: { exit_code: 0, signal: null, terminal_id: 't1' }
      })
    )
    expect(second.terminalOutput).toBe('hello world')
    expect(second.terminalExitCode).toBe(0)
  })

  it('leaves the stored text alone when a chunk has no data', () => {
    const next = applyTerminalStream(
      { terminalOutput: 'kept' },
      call({ terminal_output_delta: { terminal_id: 't1' } })
    )
    expect(next.terminalOutput).toBe('kept')
  })
})
