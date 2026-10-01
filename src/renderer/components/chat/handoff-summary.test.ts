import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import {
  buildHandoffSummary,
  type HandoffSummaryResult,
  stripHandoffPreamble
} from './handoff-summary'

/** Private-use sentinels `\uE000`–`\uE007` (skill/command/file token markers). */
const SENTINEL_RE = /[\uE000-\uE007]/

function msg(
  id: string,
  role: ChatMessage['role'],
  seq: number,
  text: string,
  streaming = false
): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], streaming, timestamp: seq * 10, seq }
}

function tool(id: string, seq: number, partial: Partial<ToolCall> = {}): ToolCall {
  return { toolCallId: id, timestamp: seq * 10, seq, ...partial }
}

/** `turnCount` user→agent turns with stable, distinct text (seq-stamped). */
function transcript(turnCount: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 1; i <= turnCount; i++) {
    const base = (i - 1) * 2
    messages.push(msg(`u${i}`, 'user', base + 1, `user message ${i}`))
    messages.push(msg(`a${i}`, 'agent', base + 2, `agent reply ${i}`))
  }
  return messages
}

/** The single wire text block's text (asserts the one-block invariant). */
function wireTextOf(result: HandoffSummaryResult): string {
  expect(result.wireBlocks.length).toBeLessThanOrEqual(1)
  const block = result.wireBlocks[0]
  expect(block?.type).toBe('text')
  return (block?.text ?? '') as string
}

describe('buildHandoffSummary', () => {
  describe('happy path: framed summary + pending message', () => {
    const messages = [
      msg('u1', 'user', 1, 'Fix the login bug in auth.ts'),
      msg('a1', 'agent', 3, 'The bug is on line 12 — a stale session token.'),
      msg('u2', 'user', 4, 'Also add a test for it'),
      msg('a2', 'agent', 5, 'Done — test added.')
    ]
    const toolCalls = [
      tool('t1', 2, { kind: 'read', rawInput: { path: 'src/auth.ts', startLine: 1, endLine: 40 } })
    ]
    const result = buildHandoffSummary({
      messages,
      toolCalls,
      agentName: 'OMP',
      pendingText: 'continue the refactor'
    })

    const expectedSummary = `# Conversation handoff

You are taking over a conversation previously handled by OMP. Summary of the prior conversation:

User: Fix the login bug in auth.ts
- Read auth.ts L1-40
Agent: The bug is on line 12 — a stale session token.

User: Also add a test for it
Agent: Done — test added.`

    it('derives the exact framed summary section (prior agent named, turns, tool one-liner)', () => {
      expect(result.summaryText).toBe(expectedSummary)
    })

    it('produces exactly one wire text block: summary + separator + pending message', () => {
      expect(result.wireBlocks).toEqual([
        { type: 'text', text: `${expectedSummary}\n\n---\n\ncontinue the refactor` }
      ])
    })

    it('displayBlocks carry ONLY the pending user prompt', () => {
      expect(result.displayBlocks).toEqual([{ type: 'text', text: 'continue the refactor' }])
      expect(result.displayBlocks[0]?.text).not.toContain('# Conversation handoff')
    })

    it('includes the compact tool one-liner derived via describeToolCall', () => {
      expect(result.summaryText).toContain('- Read auth.ts L1-40')
      expect(result.summaryText).not.toContain('rawInput')
    })

    it('never leaks a private-use sentinel onto the wire', () => {
      expect(SENTINEL_RE.test(wireTextOf(result))).toBe(false)
    })
  })

  describe('empty transcript, non-empty pending', () => {
    const result = buildHandoffSummary({
      messages: [],
      toolCalls: [],
      agentName: 'OMP',
      pendingText: 'hi'
    })

    it('has no summary section and wires just the pending text', () => {
      expect(result.summaryText).toBe('')
      expect(result.wireBlocks).toEqual([{ type: 'text', text: 'hi' }])
      expect(result.displayBlocks).toEqual([{ type: 'text', text: 'hi' }])
    })

    it('preserves newlines in the pending message (free-form, not a fragment)', () => {
      const result = buildHandoffSummary({
        messages: [],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'first line\n\nsecond line'
      })
      expect(result.wireBlocks).toEqual([{ type: 'text', text: 'first line\n\nsecond line' }])
      expect(result.displayBlocks).toEqual([{ type: 'text', text: 'first line\n\nsecond line' }])
    })
  })

  describe('empty pending text', () => {
    const result = buildHandoffSummary({
      messages: [msg('u1', 'user', 1, 'hello'), msg('a1', 'agent', 2, 'hi there')],
      toolCalls: [],
      agentName: 'OMP',
      pendingText: ''
    })

    it('wires a summary-only prompt (handoff proceeds without a new user message)', () => {
      expect(result.wireBlocks).toEqual([{ type: 'text', text: result.summaryText }])
      expect(result.wireBlocks[0]?.text).toContain('Agent: hi there')
      expect(result.wireBlocks[0]?.text).not.toContain('---')
    })

    it('displayBlocks is empty — the caller opts out of an empty turn', () => {
      expect(result.displayBlocks).toEqual([])
    })
  })

  describe('both empty', () => {
    it('returns no wire or display blocks', () => {
      const result = buildHandoffSummary({
        messages: [],
        toolCalls: [],
        agentName: null,
        pendingText: ''
      })
      expect(result.wireBlocks).toEqual([])
      expect(result.displayBlocks).toEqual([])
    })
  })

  describe('sentinel tokens in transcript text', () => {
    it('replaces well-formed tokens with readable forms in the wire prompt', () => {
      const result = buildHandoffSummary({
        messages: [
          msg(
            'u1',
            'user',
            1,
            'Run \uE000deploy\uE001 for \uE004build\uE005 and \uE006auth.ts\u001F/src/auth.ts\uE007'
          ),
          msg('a1', 'agent', 2, 'done \uE000deploy\uE001')
        ],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'ship \uE000lint\uE001'
      })
      const wire = wireTextOf(result)
      expect(wire).toContain('Run (deploy) for /build and (auth.ts)')
      expect(wire).toContain('done (deploy)')
      expect(wire).toContain('ship (lint)')
      expect(SENTINEL_RE.test(wire)).toBe(false)
    })

    it('displayBlocks keep the raw pending token text for inline chip rendering', () => {
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'go')],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'ship \uE000lint\uE001'
      })
      expect(result.displayBlocks).toEqual([{ type: 'text', text: 'ship \uE000lint\uE001' }])
    })

    it('strips malformed/unterminated sentinel leftovers from the wire', () => {
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'broken \uE000stray and \uE006dangling')],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'next \uE000open-ended'
      })
      const wire = wireTextOf(result)
      expect(SENTINEL_RE.test(wire)).toBe(false)
      expect(wire).toContain('broken stray and dangling')
      expect(wire).toContain('next open-ended')
    })

    it('sanitizes a sentinel-bearing agent name in the preamble', () => {
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'go')],
        toolCalls: [],
        agentName: 'OMP \uE000evil\uE001',
        pendingText: 'go'
      })
      const wire = wireTextOf(result)
      expect(SENTINEL_RE.test(wire)).toBe(false)
      expect(wire).toContain('previously handled by OMP (evil)')
    })

    it('strips a malformed file token separator (\\u001F) from the wire', () => {
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'broken \uE006auth\u001F/src/auth.ts')],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      const wire = wireTextOf(result)
      expect(wire).not.toContain('\u001F')
      expect(wire).toContain('broken auth/src/auth.ts')
    })

    it('truncates a 200+ char fragment with an ellipsis marker', () => {
      const long = 'a'.repeat(4000)
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, long)],
        toolCalls: [tool('t1', 2, { kind: 'execute', rawInput: { command: long } })],
        agentName: 'OMP',
        pendingText: 'go'
      })
      const lines = result.summaryText.split('\n')
      const userLine = lines.find((l) => l.startsWith('User: ')) ?? ''
      const toolLine = lines.find((l) => l.startsWith('- Ran ')) ?? ''
      expect(userLine).toBe(`User: ${'a'.repeat(200)}…`)
      // The one-liner fragment (verb + command) is capped at 200 chars.
      expect(toolLine).toBe(`- Ran ${'a'.repeat(196)}…`)
      expect(result.summaryText.length).toBeLessThan(600)
    })

    it('emits a placeholder for an attachment-only user turn', () => {
      const result = buildHandoffSummary({
        messages: [
          {
            id: 'u1',
            role: 'user',
            blocks: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
            streaming: false,
            timestamp: 10,
            seq: 1
          },
          msg('a1', 'agent', 2, 'got the screenshot, thanks')
        ],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('User: [shared an attachment]')
      expect(result.summaryText).toContain('Agent: got the screenshot, thanks')
    })

    it('collapses multi-line tool text and agent text to single lines', () => {
      const result = buildHandoffSummary({
        messages: [msg('a1', 'agent', 2, 'line one\nline two\n\nline three')],
        toolCalls: [
          tool('t1', 1, {
            kind: 'execute',
            rawInput: { command: 'echo hi\necho bye\n\nsync' }
          })
        ],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('- Ran echo hi echo bye sync')
      expect(result.summaryText).toContain('Agent: line one line two line three')
      // Line grammar intact: every turn line stays a single physical line.
      expect(result.summaryText.split('\n')).toContain('- Ran echo hi echo bye sync')
    })
  })

  describe('streaming/empty tail', () => {
    it('skips trailing empty and whitespace-only agent messages', () => {
      const result = buildHandoffSummary({
        messages: [
          msg('u1', 'user', 1, 'hi'),
          msg('a1', 'agent', 2, 'hello'),
          msg('a2', 'agent', 3, '', true),
          msg('a3', 'agent', 4, '   ')
        ],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'again'
      })
      expect(result.summaryText).toBe(`# Conversation handoff

You are taking over a conversation previously handled by OMP. Summary of the prior conversation:

User: hi
Agent: hello`)
    })

    it('excludes a think tool call (internal reasoning) from the summary', () => {
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'why did it fail?'), msg('a1', 'agent', 3, 'type error')],
        toolCalls: [
          tool('t1', 2, { kind: 'think', rawInput: { thought: 'internal reasoning here' } })
        ],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).not.toContain('internal reasoning')
      expect(result.summaryText).not.toContain('- Thinking internal')
      expect(result.summaryText).toContain('Agent: type error')
    })

    it('excludes a streaming agent message with substantive text', () => {
      const result = buildHandoffSummary({
        messages: [
          msg('u1', 'user', 1, 'hi'),
          msg('a1', 'agent', 2, 'settled reply'),
          msg('a2', 'agent', 3, 'still streaming, not settled', true)
        ],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('Agent: settled reply')
      expect(result.summaryText).not.toContain('still streaming')
    })

    it('drops an agent-only prelude turn with no substantive content', () => {
      const result = buildHandoffSummary({
        messages: [msg('a0', 'agent', 1, ''), msg('u1', 'user', 2, 'start')],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('User: start')
      expect(result.summaryText).not.toMatch(/^# Conversation handoff\n\n.*\n\n\n/m)
    })
  })

  describe('total output budget', () => {
    it('caps a single turn holding 100 tool calls within the body budget', () => {
      const toolCalls = Array.from({ length: 100 }, (_, i) =>
        tool(`t${i}`, i + 2, {
          kind: 'execute',
          rawInput: { command: `step ${i} ${'x'.repeat(180)}` }
        })
      )
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'run everything')],
        toolCalls,
        agentName: 'OMP',
        pendingText: 'go'
      })
      const summary = result.summaryText
      expect(summary).toContain('User: run everything')
      expect(summary).toContain('[… summary truncated …]')
      // Header + preamble + separators sit on top of the 4000-char body cap.
      expect(summary.length).toBeLessThanOrEqual(4400)
      // The newest tool lines survive; the oldest are the dropped ones.
      expect(summary).toContain('- Ran step 99')
      expect(summary).not.toContain('- Ran step 0')
    })
  })

  describe('bounded cap (long transcript)', () => {
    it('keeps the default tail of 12 turns plus the first user message as anchor', () => {
      const result = buildHandoffSummary({
        messages: transcript(60),
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      const summary = result.summaryText
      expect(summary).toContain('[… 47 earlier turns omitted …]')
      expect(summary).toContain('User: user message 1\n')
      expect(summary).toContain('User: user message 49\n')
      expect(summary).toContain('Agent: agent reply 60')
      expect(summary).not.toContain('User: user message 48\n')
      expect(summary).not.toContain('Agent: agent reply 2\n')
    })

    it('counts no phantom omission when the anchor and the next turn are both present', () => {
      // 13 turns, cap 12: turn 1 (anchor) drops out of the tail but is
      // surfaced as the anchor line, and turn 2 is in the tail — zero turns
      // are actually hidden, so no omission marker may appear.
      const result = buildHandoffSummary({
        messages: transcript(13),
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).not.toContain('earlier turn')
      expect(result.summaryText).toContain('User: user message 1\n')
      expect(result.summaryText).toContain('User: user message 2\n')
    })

    it('uses the singular omission marker when exactly one turn is hidden', () => {
      // 14 turns, cap 12: tail = turns 3-14, anchor = turn 1 → exactly
      // turn 2 is hidden.
      const result = buildHandoffSummary({
        messages: transcript(14),
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('[… 1 earlier turn omitted …]')
      expect(result.summaryText).toContain('User: user message 1\n')
      expect(result.summaryText).toContain('User: user message 3\n')
      expect(result.summaryText).not.toContain('User: user message 2\n')
    })

    it('honors a smaller options.maxTurns window', () => {
      const result = buildHandoffSummary({
        messages: transcript(5),
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go',
        options: { maxTurns: 2 }
      })
      const summary = result.summaryText
      expect(summary).toContain('[… 2 earlier turns omitted …]')
      expect(summary).toContain('User: user message 1\n')
      expect(summary).toContain('User: user message 4\n')
      expect(summary).toContain('Agent: agent reply 5')
      expect(summary).not.toContain('User: user message 3\n')
    })

    it('grows sublinearly: 200 turns barely exceed the 60-turn summary', () => {
      const base = { toolCalls: [] as ToolCall[], agentName: 'OMP', pendingText: 'go' }
      const s60 = buildHandoffSummary({ ...base, messages: transcript(60) }).summaryText
      const s200 = buildHandoffSummary({ ...base, messages: transcript(200) }).summaryText
      expect(s200.length - s60.length).toBeLessThan(100)
      const verbatim = transcript(200)
        .map((m) => m.blocks.map((b) => b.text ?? '').join(''))
        .join('\n')
      expect(s200.length).toBeLessThan(verbatim.length / 4)
    })
  })

  describe('unknown agent name', () => {
    const messages = [msg('u1', 'user', 1, 'hello'), msg('a1', 'agent', 2, 'hi')]

    it('falls back to the generic label for null', () => {
      const result = buildHandoffSummary({
        messages,
        toolCalls: [],
        agentName: null,
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('previously handled by the previous agent')
    })

    it('falls back for undefined and blank names without throwing', () => {
      for (const agentName of [undefined, '', '   '] as Array<string | null | undefined>) {
        const result = buildHandoffSummary({
          messages,
          toolCalls: [],
          agentName: agentName as string | null,
          pendingText: 'go'
        })
        expect(result.summaryText).toContain('the previous agent')
      }
    })
  })

  describe('thought messages', () => {
    it('excludes internal reasoning from the summary', () => {
      const result = buildHandoffSummary({
        messages: [
          msg('u1', 'user', 1, 'why did it fail?'),
          msg('th1', 'thought', 2, 'internal reasoning about the stack trace'),
          msg('a1', 'agent', 3, 'The build failed on a type error.')
        ],
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      expect(result.summaryText).toContain('Agent: The build failed on a type error.')
      expect(result.summaryText).not.toContain('internal reasoning')
    })
  })

  describe('ordering', () => {
    it('interleaves tool calls between turns by arrival (seq) order', () => {
      const result = buildHandoffSummary({
        messages: [msg('u1', 'user', 1, 'inspect the file'), msg('a1', 'agent', 3, 'looks fine')],
        toolCalls: [tool('t1', 2, { kind: 'read', rawInput: { path: 'src/a.ts' } })],
        agentName: 'OMP',
        pendingText: 'go'
      })
      const lines = result.summaryText.split('\n')
      expect(lines.indexOf('- Read a.ts')).toBeGreaterThan(lines.indexOf('User: inspect the file'))
      expect(lines.indexOf('Agent: looks fine')).toBeGreaterThan(lines.indexOf('- Read a.ts'))
    })

    it('orders seqless history by timestamp', () => {
      const messages: ChatMessage[] = [
        {
          id: 'h1',
          role: 'user',
          blocks: [{ type: 'text', text: 'first' }],
          streaming: false,
          timestamp: 10
        },
        {
          id: 'h2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'second' }],
          streaming: false,
          timestamp: 20
        }
      ]
      const result = buildHandoffSummary({
        messages,
        toolCalls: [],
        agentName: 'OMP',
        pendingText: 'go'
      })
      const summary = result.summaryText
      expect(summary.indexOf('User: first')).toBeGreaterThan(-1)
      expect(summary.indexOf('Agent: second')).toBeGreaterThan(summary.indexOf('User: first'))
    })
  })

  describe('determinism', () => {
    it('returns byte-identical output for identical inputs', () => {
      const input = {
        messages: [...transcript(15), msg('u-extra', 'user', 99, 'final \uE000skill\uE001 note')],
        toolCalls: [
          tool('t1', 50, {
            kind: 'edit',
            content: [{ type: 'diff', path: 'x.ts', newText: 'a\nb' }]
          })
        ],
        agentName: 'OMP',
        pendingText: 'wrap up'
      }
      const a = buildHandoffSummary(input)
      const b = buildHandoffSummary(input)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a.wireBlocks).toEqual(b.wireBlocks)
      expect(a.displayBlocks).toEqual(b.displayBlocks)
    })
  })

  describe('stripHandoffPreamble (spec-agent-switch-separator-redesign)', () => {
    it('returns only the draft when the persisted text carries the handoff framing', () => {
      const wire = `# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.\n\nUser: hi\nAgent: hello\n\n---\n\ncontinue the work`
      expect(stripHandoffPreamble(wire)).toBe('continue the work')
    })

    it('returns null for a summary-only record (no draft separator)', () => {
      const summaryOnly = `# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.\n\nUser: hi\nAgent: hello`
      expect(stripHandoffPreamble(summaryOnly)).toBeNull()
    })

    it('returns null when the draft after the separator is empty', () => {
      const trailingOnly = `# Conversation handoff\n\n…\n\n---\n\n   `
      expect(stripHandoffPreamble(trailingOnly)).toBeNull()
    })

    it('leaves a non-handoff text unchanged', () => {
      expect(stripHandoffPreamble('just a normal prompt')).toBe('just a normal prompt')
    })

    it('splits only on the FIRST separator — a draft containing --- survives', () => {
      const wire = `# Conversation handoff\n\n…\n\n---\n\nfirst --- then more`
      expect(stripHandoffPreamble(wire)).toBe('first --- then more')
    })
  })
})
