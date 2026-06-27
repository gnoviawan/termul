import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import { baseName, describeToolCall, readableOutput } from './tool-call-summary'

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
    expect(s.detail).toBe('+5 \u22123')
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
