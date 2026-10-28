import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CLEAR_LINE_SEQUENCE,
  parseSessionFrame,
  RESTORE_PROMPT_SEQUENCE,
  SESSION_RPC_RESULTS,
  serializeSessionRpcResult
} from './command-session'

function terminalApiInterfaceSource(): string {
  const source = readFileSync(join(process.cwd(), 'src/shared/types/ipc.types.ts'), 'utf8')
  const start = source.indexOf('export interface TerminalApi {')
  if (start < 0) throw new Error('TerminalApi interface is missing')
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    const char = source[index]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('TerminalApi interface is unterminated')
}

const COMPLETE_COMPLETION = {
  type: 'Completion',
  session_id: 's1',
  nonce: 'n1',
  request_id: 'r1',
  buffer_revision: 3,
  cursor: 4,
  prompt_generation: 7,
  cwd: '/repo',
  output: 'status\nstash'
} as const

const VALIDITY_FIELDS = [
  'session_id',
  'nonce',
  'request_id',
  'buffer_revision',
  'cursor',
  'prompt_generation',
  'cwd',
  'output'
] as const

const MODE_FRAMES = ['InitShell', 'PromptReady', 'CommandStarted', 'CommandFinished'] as const

describe('command session protocol', () => {
  it('completion validity fields', () => {
    const parsed = parseSessionFrame({ ...COMPLETE_COMPLETION })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frame.type).toBe('Completion')
    expect(MODE_FRAMES).not.toContain(parsed.frame.type)
    if (parsed.frame.type !== 'Completion') return
    expect(parsed.frame.result).toEqual({
      session_id: 's1',
      nonce: 'n1',
      request_id: 'r1',
      buffer_revision: 3,
      cursor: 4,
      prompt_generation: 7,
      cwd: '/repo',
      output: 'status\nstash'
    })

    for (const field of VALIDITY_FIELDS) {
      const payload: Record<string, unknown> = { ...COMPLETE_COMPLETION }
      delete payload[field]
      const rejected = parseSessionFrame(payload)
      expect(rejected.ok, `missing ${field} must be rejected`).toBe(false)
    }
  })

  it('completion rejects a non-string output', () => {
    expect(parseSessionFrame({ ...COMPLETE_COMPLETION, output: 5 })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('prompt frame keeps its fields', () => {
    const parsed = parseSessionFrame({
      type: 'PromptReady',
      nonce: 'n1',
      prompt_generation: 4,
      line_empty: true,
      prompt_suppressed: true,
      cwd: '/repo'
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.frame.type !== 'PromptReady') {
      throw new Error('expected a PromptReady frame')
    }
    expect(parsed.frame.nonce).toBe('n1')
    expect(parsed.frame.prompt_generation).toBe(4)
    expect(parsed.frame.line_empty).toBe(true)
    expect(parsed.frame.prompt_suppressed).toBe(true)
    expect(parsed.frame.cwd).toBe('/repo')
  })

  it('prompt frame requires its fields', () => {
    const base = {
      type: 'PromptReady',
      nonce: 'n1',
      prompt_generation: 4,
      line_empty: true,
      prompt_suppressed: true,
      cwd: '/repo'
    }
    for (const field of [
      'nonce',
      'prompt_generation',
      'line_empty',
      'prompt_suppressed',
      'cwd'
    ] as const) {
      const payload: Record<string, unknown> = { ...base }
      delete payload[field]
      const parsed = parseSessionFrame(payload)
      const acceptedAsPrompt = parsed.ok && parsed.frame.type === 'PromptReady'
      expect(acceptedAsPrompt, `omitted ${field} must not be a prompt frame`).toBe(false)
    }
  })

  it('false prompt flag still parses', () => {
    const parsed = parseSessionFrame({
      type: 'PromptReady',
      nonce: 'n1',
      prompt_generation: 4,
      line_empty: false,
      prompt_suppressed: false,
      cwd: '/repo'
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.frame.type !== 'PromptReady') {
      throw new Error('expected a PromptReady frame')
    }
    expect(parsed.frame.line_empty).toBe(false)
    expect(parsed.frame.prompt_suppressed).toBe(false)
    expect(parsed.frame.nonce).toBe('n1')
    expect(parsed.frame.prompt_generation).toBe(4)
    expect(parsed.frame.cwd).toBe('/repo')
  })

  it('command finished keeps its exit code', () => {
    const parsed = parseSessionFrame({
      type: 'CommandFinished',
      exit_code: 2
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.frame.type !== 'CommandFinished') {
      throw new Error('expected a CommandFinished frame')
    }
    expect(parsed.frame.exit_code).toBe(2)
  })

  it('command finished may omit its exit code', () => {
    const parsed = parseSessionFrame({ type: 'CommandFinished' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.frame.type !== 'CommandFinished') {
      throw new Error('expected a CommandFinished frame')
    }
    expect(parsed.frame.exit_code).toBeUndefined()
  })

  it('init shell keeps its registration', () => {
    const parsed = parseSessionFrame({
      type: 'InitShell',
      session_id: 's1',
      nonce: 'n1'
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.frame.type !== 'InitShell') {
      throw new Error('expected an InitShell frame')
    }
    expect(parsed.frame.session_id).toBe('s1')
    expect(parsed.frame.nonce).toBe('n1')
  })

  it('init shell requires its registration', () => {
    const base = { type: 'InitShell', session_id: 's1', nonce: 'n1' }
    for (const field of ['session_id', 'nonce'] as const) {
      const payload: Record<string, unknown> = { ...base }
      delete payload[field]
      const parsed = parseSessionFrame(payload)
      const acceptedAsInit = parsed.ok && parsed.frame.type === 'InitShell'
      expect(acceptedAsInit, `omitted ${field} must not be InitShell`).toBe(false)
    }
  })

  it('nonce mismatch is not a mode signal', () => {
    const parsed = parseSessionFrame(
      {
        type: 'PromptReady',
        nonce: 'other',
        prompt_generation: 4,
        line_empty: true,
        prompt_suppressed: true,
        cwd: '/repo'
      },
      'registered'
    )
    const modeSignal =
      parsed.ok &&
      (parsed.frame.type === 'PromptReady' ||
        parsed.frame.type === 'CommandStarted' ||
        parsed.frame.type === 'CommandFinished')
    expect(modeSignal).toBe(false)
  })

  it('TerminalApi session methods', () => {
    const iface = terminalApiInterfaceSource()
    expect(iface).toContain('submitCommand:')
    expect(iface).toContain('requestCompletion:')
    expect(iface).toContain('cancelCompletion:')
    expect(iface).toContain('write: (terminalId: string, data: string)')
  })

  it('one clear-line sequence', () => {
    expect(CLEAR_LINE_SEQUENCE).toBe('\u001b[99;1~')
    expect(CLEAR_LINE_SEQUENCE).not.toMatch(/[A-Za-z]/)
  })

  it('submit result names', () => {
    const serialized = SESSION_RPC_RESULTS.map((name) => serializeSessionRpcResult(name))
    expect(serialized).toEqual(['"Accepted"', '"PreWrite"', '"Partial"', '"NotStarted"'])
    expect(serialized.map((value) => JSON.parse(value))).toEqual([
      'Accepted',
      'PreWrite',
      'Partial',
      'NotStarted'
    ])
  })

  it('restore-prompt sequence', () => {
    expect(RESTORE_PROMPT_SEQUENCE).toBe('\u001b[99;2~')
    expect(RESTORE_PROMPT_SEQUENCE).not.toBe(CLEAR_LINE_SEQUENCE)
  })

  it('restorePrompt is a TerminalApi method', () => {
    const iface = terminalApiInterfaceSource()
    expect(iface).toContain('restorePrompt:')
    expect(iface).toContain('submitCommand:')
    expect(iface).toContain('requestCompletion:')
    expect(iface).toContain('cancelCompletion:')
    expect(iface).toContain('write: (terminalId: string, data: string)')
    expect(iface).toMatch(/restorePrompt:\s*\(\s*terminalId:\s*string\s*\)/)
  })
})

describe('authenticated command frames', () => {
  it('command started keeps its nonce', () => {
    expect(parseSessionFrame({ type: 'CommandStarted', nonce: 'n1' }, 'n1')).toEqual({
      ok: true,
      frame: { type: 'CommandStarted', nonce: 'n1' }
    })
  })

  it('command finished keeps its nonce and exit code', () => {
    expect(parseSessionFrame({ type: 'CommandFinished', nonce: 'n1', exit_code: 2 }, 'n1')).toEqual(
      {
        ok: true,
        frame: { type: 'CommandFinished', nonce: 'n1', exit_code: 2 }
      }
    )
  })

  it('command started rejects a non-string nonce', () => {
    expect(parseSessionFrame({ type: 'CommandStarted', nonce: 7 })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })
})
