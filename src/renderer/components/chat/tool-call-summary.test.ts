import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  baseName,
  describeToolCall,
  isSubagentCall,
  readableOutput,
  toolCallPath
} from './tool-call-summary'

function call(partial: Partial<ToolCall>): ToolCall {
  return { toolCallId: 't1', ...partial }
}

describe('baseName', () => {
  it('returns the final segment for posix and windows paths', () => {
    expect(baseName('/a/b/UiKit.tsx')).toBe('UiKit.tsx')
    expect(baseName('C:\\src\\components\\UiKit.tsx')).toBe('UiKit.tsx')
    expect(baseName('UiKit.tsx')).toBe('UiKit.tsx')
  })
})

describe('describeToolCall', () => {
  it('reads a file with a line range from input', () => {
    const s = describeToolCall(
      call({ kind: 'read', rawInput: { path: 'src/UiKit.tsx', startLine: 185, endLine: 219 } })
    )
    expect(s).toEqual({ verb: 'Read', primary: 'UiKit.tsx', detail: 'L185-219' })
  })

  it('reads a file without a range when keys are absent', () => {
    const s = describeToolCall(call({ kind: 'read', rawInput: { path: 'a/b/foo.ts' } }))
    expect(s).toEqual({ verb: 'Read', primary: 'foo.ts', detail: null })
  })

  it('derives an edit summary (path + counts) from diff content', () => {
    const s = describeToolCall(
      call({
        kind: 'edit',
        content: [
          { type: 'diff', path: 'src/UiKit.tsx', oldText: 'a\nb\nc', newText: 'a\nB\nc\nd\ne' }
        ]
      })
    )
    expect(s.verb).toBe('Edited')
    expect(s.primary).toBe('UiKit.tsx')
    // LCS of [a,b,c] vs [a,B,c,d,e] is [a,c] (len 2) → +3 −1 (not +5 −3)
    expect(s.detail).toBe('+3 \u22121')
  })

  it('shows only additions for a new file', () => {
    const s = describeToolCall(
      call({ kind: 'edit', content: [{ type: 'diff', path: 'new.ts', newText: 'x\ny' }] })
    )
    expect(s.detail).toBe('+2')
  })

  it('summarizes an executed command', () => {
    const s = describeToolCall(call({ kind: 'execute', rawInput: { command: 'bun run test' } }))
    expect(s).toEqual({ verb: 'Ran', primary: 'bun run test', detail: null })
  })

  it('summarizes a search query', () => {
    const s = describeToolCall(call({ kind: 'search', rawInput: { query: 'useEffect' } }))
    expect(s).toEqual({ verb: 'Searched', primary: 'useEffect', detail: null })
  })

  it('falls back to the agent title for unknown tools', () => {
    const s = describeToolCall(call({ kind: undefined, title: 'Custom MCP tool' }))
    expect(s.primary).toBe('Custom MCP tool')
  })

  it('falls back to title when an execute command is not in input', () => {
    const s = describeToolCall(call({ kind: 'execute', title: 'git status' }))
    expect(s.primary).toBe('git status')
  })

  it('renders a subagent/Task call as the task name with no verb', () => {
    const s = describeToolCall(
      call({
        kind: 'think',
        title: 'Task',
        rawInput: {
          subagent_type: 'explore',
          description: 'Find chat response cursor rendering',
          prompt: 'long prompt...'
        }
      })
    )
    expect(s).toEqual({
      verb: '',
      primary: 'Find chat response cursor rendering',
      detail: null
    })
  })

  it('still renders a genuine think call as "Thinking"', () => {
    const s = describeToolCall(call({ kind: 'think', rawInput: { thought: 'pondering' } }))
    expect(s).toEqual({ verb: 'Thinking', primary: 'pondering', detail: null })
  })
})

describe('isSubagentCall', () => {
  it('detects a subagent_type input', () => {
    expect(isSubagentCall(call({ rawInput: { subagent_type: 'explore' } }))).toBe(true)
  })

  it('detects a description + prompt input', () => {
    expect(isSubagentCall(call({ rawInput: { description: 'do x', prompt: 'p' } }))).toBe(true)
  })

  it('is false for a plain think call', () => {
    expect(isSubagentCall(call({ kind: 'think', rawInput: { thought: 'pondering' } }))).toBe(false)
  })

  it('is false when rawInput is absent', () => {
    expect(isSubagentCall(call({ kind: 'read', title: 'Task' }))).toBe(false)
  })
})

describe('readableOutput', () => {
  it('returns a plain string as-is', () => {
    expect(readableOutput('done')).toBe('done')
  })

  it('extracts the output field from a search result envelope', () => {
    const out = readableOutput({ metadata: { matches: 6 }, output: 'Found 6 matches\n...' })
    expect(out).toBe('Found 6 matches\n...')
  })

  it('extracts a unified diff from edit metadata when no direct output', () => {
    const out = readableOutput({ metadata: { diff: 'Index: a\n--- a\n+++ b' } })
    expect(out).toBe('Index: a\n--- a\n+++ b')
  })

  it('extracts a file patch when present', () => {
    const out = readableOutput({ metadata: { fileDiff: { patch: '@@ -1 +1 @@' } } })
    expect(out).toBe('@@ -1 +1 @@')
  })

  it('returns empty (never raw JSON) when nothing readable exists', () => {
    expect(readableOutput({ metadata: { ids: [1, 2] } })).toBe('')
    expect(readableOutput(null)).toBe('')
  })
})

describe('toolCallPath', () => {
  it('prefers locations[0].path over rawInput and diff content', () => {
    const p = toolCallPath(
      call({
        kind: 'edit',
        rawInput: { filePath: 'src/from-input.ts' },
        content: [{ type: 'diff', path: 'src/from-diff.ts', newText: 'x' }],
        locations: [{ path: 'src/from-locations.ts' }]
      })
    )
    expect(p).toBe('src/from-locations.ts')
  })

  it('falls back to rawInput when locations is absent', () => {
    const p = toolCallPath(call({ kind: 'edit', rawInput: { path: 'src/from-input.ts' } }))
    expect(p).toBe('src/from-input.ts')
  })

  it('falls back to diff content path when locations and rawInput are absent', () => {
    const p = toolCallPath(
      call({
        kind: 'edit',
        content: [{ type: 'diff', path: 'src/from-diff.ts', newText: 'x' }]
      })
    )
    expect(p).toBe('src/from-diff.ts')
  })

  it('returns undefined when no path source is available', () => {
    expect(toolCallPath(call({ kind: 'edit', rawInput: { command: 'ls' } }))).toBeUndefined()
    expect(toolCallPath(call({ kind: 'edit' }))).toBeUndefined()
  })
})
