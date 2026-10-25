import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  baseName,
  describeToolCall,
  isSubagentCall,
  isSubagentRunning,
  readableOutput,
  summarizeToolActivity,
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

  it('uses the present tense while the call has not settled', () => {
    for (const status of ['pending', 'in_progress'] as const) {
      expect(
        describeToolCall(call({ kind: 'read', status, rawInput: { path: 'a.ts' } })).verb
      ).toBe('Reading')
    }
    expect(describeToolCall(call({ kind: 'execute', status: 'in_progress' })).verb).toBe('Running')
    expect(describeToolCall(call({ kind: 'read', status: 'completed' })).verb).toBe('Read')
    expect(describeToolCall(call({ kind: 'read', status: 'failed' })).verb).toBe('Read')
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

  it('falls back to the restored diffStat when an edit has no diff content', () => {
    const s = describeToolCall(
      call({
        kind: 'edit',
        locations: [{ path: 'src/a.ts' }],
        diffStat: { added: 5, removed: 1 },
        restoredSummary: true
      })
    )
    expect(s).toEqual({
      verb: 'Edited',
      primary: 'a.ts',
      detail: '+5 \u22121',
      diffStat: { added: 5, removed: 1 }
    })
  })

  it('shows only additions for a restored diffStat with no removals', () => {
    const s = describeToolCall(
      call({ kind: 'edit', locations: [{ path: 'a.ts' }], diffStat: { added: 2, removed: 0 } })
    )
    expect(s.detail).toBe('+2')
    expect(s.diffStat).toEqual({ added: 2, removed: 0 })
  })

  it('prefers live diff content over a stale diffStat', () => {
    const s = describeToolCall(
      call({
        kind: 'edit',
        content: [{ type: 'diff', path: 'new.ts', newText: 'x\ny' }],
        diffStat: { added: 99, removed: 99 }
      })
    )
    expect(s.detail).toBe('+2')
    expect(s.diffStat).toEqual({ added: 2, removed: 0 })
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['non-object', 7],
    ['missing removed', { added: 3 }],
    ['negative count', { added: -1, removed: 0 }],
    ['fractional count', { added: 1.5, removed: 0 }],
    ['NaN count', { added: Number.NaN, removed: 0 }],
    ['string count', { added: '3', removed: '1' }]
  ])('ignores a %s diffStat (legacy/corrupt record)', (_label, diffStat) => {
    const s = describeToolCall(
      call({ kind: 'edit', locations: [{ path: 'a.ts' }], diffStat: diffStat as never })
    )
    expect(s.detail).toBeNull()
    expect(s.diffStat).toBeNull()
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

  it('detects a Codex subagent rawInput', () => {
    expect(isSubagentCall(call({ rawInput: { prompt: 'review', senderThreadId: 'parent' } }))).toBe(
      true
    )
    expect(
      isSubagentCall(call({ rawInput: { agentThreadId: 'child', activityKind: 'start' } }))
    ).toBe(true)
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

describe('summarizeToolActivity', () => {
  const subagent = (extra?: Record<string, unknown>): ToolCall =>
    call({
      kind: 'think',
      rawInput: { subagent_type: 'explore', description: 'Audit branch', prompt: 'p', ...extra }
    })

  it('returns null for a turn with no tool calls', () => {
    expect(summarizeToolActivity([])).toBeNull()
  })

  it.each([
    ['execute', 2, 'Ran 1 command', 'Ran 2 commands'],
    ['read', 2, 'Read 1 file', 'Read 2 files'],
    ['delete', 2, 'Deleted 1 file', 'Deleted 2 files'],
    ['move', 2, 'Moved 1 file', 'Moved 2 files'],
    ['search', 2, 'Ran 1 search', 'Ran 2 searches'],
    ['fetch', 2, 'Fetched 1 page', 'Fetched 2 pages'],
    ['switch_mode', 3, 'Switched mode', 'Switched mode 3 times'],
    ['think', 2, 'Used 1 tool', 'Used 2 tools'],
    ['other', 2, 'Used 1 tool', 'Used 2 tools'],
    [undefined, 2, 'Used 1 tool', 'Used 2 tools']
  ])('classifies kind %s as "%s" / "%s"', (kind, n, singular, plural) => {
    expect(summarizeToolActivity([call({ kind })])?.label).toBe(singular)
    const calls = Array.from({ length: n }, () => call({ kind }))
    expect(summarizeToolActivity(calls)?.label).toBe(plural)
  })

  it('counts a subagent dispatch as an agent', () => {
    expect(summarizeToolActivity([subagent()])?.label).toBe('Ran 1 agent')
    expect(summarizeToolActivity([subagent(), subagent()])?.label).toBe('Ran 2 agents')
  })

  it.each([
    'run_in_background',
    'is_background',
    'background'
  ])('counts a subagent with %s: true as a background agent', (key) => {
    expect(summarizeToolActivity([subagent({ [key]: true })])?.label).toBe('Ran 1 background agent')
    expect(
      summarizeToolActivity([subagent({ [key]: true }), subagent({ [key]: true })])?.label
    ).toBe('Ran 2 background agents')
  })

  it('keeps a non-true background flag as a plain agent', () => {
    expect(summarizeToolActivity([subagent({ background: false })])?.label).toBe('Ran 1 agent')
    expect(summarizeToolActivity([subagent({ background: 'yes' })])?.label).toBe('Ran 1 agent')
  })

  it('counts an edit whose diffs all create files as created', () => {
    const created = call({
      kind: 'edit',
      content: [
        { type: 'diff', path: 'a.ts', newText: 'x\ny' },
        { type: 'diff', path: 'b.ts', oldText: null, newText: 'z' }
      ]
    })
    expect(summarizeToolActivity([created])?.label).toBe('Created 1 file')
  })

  it('counts an edit touching existing content as edited', () => {
    const edited = call({
      kind: 'edit',
      content: [
        { type: 'diff', path: 'new.ts', newText: 'x' },
        { type: 'diff', path: 'old.ts', oldText: 'a', newText: 'b' }
      ]
    })
    expect(summarizeToolActivity([edited])?.label).toBe('Edited 1 file')
  })

  it('counts a restored edit (no diff content) as edited and keeps its diffStat', () => {
    const restored = call({
      kind: 'edit',
      locations: [{ path: 'src/a.ts' }],
      diffStat: { added: 5, removed: 1 },
      restoredSummary: true
    })
    expect(summarizeToolActivity([restored])).toEqual({
      label: 'Edited 1 file',
      added: 5,
      removed: 1
    })
  })

  it('rolls a mixed turn into first-occurrence phrases', () => {
    const summary = summarizeToolActivity([
      call({ kind: 'execute' }),
      call({ kind: 'execute' }),
      call({ kind: 'edit', content: [{ type: 'diff', path: 'a.ts', newText: 'x' }] }),
      call({ kind: 'edit', content: [{ type: 'diff', path: 'b.ts', newText: 'y' }] }),
      subagent(),
      subagent(),
      subagent(),
      subagent()
    ])
    expect(summary?.label).toBe('Ran 2 commands, created 2 files, ran 4 agents')
  })

  it('orders phrases by first occurrence, not by count', () => {
    const summary = summarizeToolActivity([
      call({ kind: 'read' }),
      call({ kind: 'execute' }),
      call({ kind: 'read' })
    ])
    expect(summary?.label).toBe('Read 2 files, ran 1 command')
  })

  it('shows four phrases without a tail when exactly four categories ran', () => {
    const summary = summarizeToolActivity([
      call({ kind: 'execute' }),
      call({ kind: 'read' }),
      call({ kind: 'search' }),
      call({ kind: 'fetch' })
    ])
    expect(summary?.label).toBe('Ran 1 command, read 1 file, ran 1 search, fetched 1 page')
  })

  it('caps at four phrases and tails the unshown call count as "and N more"', () => {
    const summary = summarizeToolActivity([
      call({ kind: 'execute' }),
      call({ kind: 'read' }),
      call({ kind: 'search' }),
      call({ kind: 'fetch' }),
      call({ kind: 'switch_mode' }),
      call({ kind: 'switch_mode' }),
      call({ kind: 'delete' })
    ])
    expect(summary?.label).toBe(
      'Ran 1 command, read 1 file, ran 1 search, fetched 1 page, and 3 more'
    )
  })

  it('sums diff counts across live diffs and restored diffStats', () => {
    const summary = summarizeToolActivity([
      call({
        kind: 'edit',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc\nd\ne' }]
      }),
      call({ kind: 'edit', locations: [{ path: 'b.ts' }], diffStat: { added: 5, removed: 1 } }),
      call({ kind: 'execute' })
    ])
    // +3 −1 from the live diff (LCS of [a,b,c] vs [a,B,c,d,e]), +5 −1 restored.
    expect(summary).toEqual({ label: 'Edited 2 files, ran 1 command', added: 8, removed: 2 })
  })

  it('leads with a single thought before the tool phrases', () => {
    const summary = summarizeToolActivity([call({ kind: 'execute' }), call({ kind: 'execute' })], {
      thoughts: 1
    })
    expect(summary).toEqual({ label: 'Thought, ran 2 commands', added: 0, removed: 0 })
  })

  it('counts repeated thoughts as "thought n times"', () => {
    const summary = summarizeToolActivity(
      [
        call({ kind: 'execute' }),
        call({
          kind: 'edit',
          content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' }]
        })
      ],
      { thoughts: 3 }
    )
    expect(summary).toEqual({
      label: 'Thought 3 times, ran 1 command, edited 1 file',
      added: 1,
      removed: 1
    })
  })

  it('summarizes thoughts without any tool calls', () => {
    expect(summarizeToolActivity([], { thoughts: 1 })).toEqual({
      label: 'Thought',
      added: 0,
      removed: 0
    })
    expect(summarizeToolActivity([], { thoughts: 2 })?.label).toBe('Thought 2 times')
  })

  it('returns null for zero thoughts and no calls', () => {
    expect(summarizeToolActivity([], { thoughts: 0 })).toBeNull()
  })

  it('counts the thought phrase toward the four-phrase cap', () => {
    const summary = summarizeToolActivity(
      [
        call({ kind: 'execute' }),
        call({ kind: 'read' }),
        call({ kind: 'search' }),
        call({ kind: 'fetch' }),
        call({ kind: 'fetch' })
      ],
      { thoughts: 2 }
    )
    expect(summary?.label).toBe(
      'Thought 2 times, ran 1 command, read 1 file, ran 1 search, and 2 more'
    )
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

describe('isSubagentRunning', () => {
  it('is running for pending and in_progress only while the parent turn is active', () => {
    expect(isSubagentRunning(call({ status: 'pending' }), true)).toBe(true)
    expect(isSubagentRunning(call({ status: 'in_progress' }), true)).toBe(true)
    // A cancelled or crashed turn can leave the dispatch in flight forever.
    expect(isSubagentRunning(call({ status: 'pending' }), false)).toBe(false)
    expect(isSubagentRunning(call({ status: 'in_progress' }), false)).toBe(false)
  })

  it('treats a missing status as running only while the parent turn is active', () => {
    expect(isSubagentRunning(call({}), true)).toBe(true)
    expect(isSubagentRunning(call({ status: undefined }), false)).toBe(false)
  })

  it('is not running once completed or failed, even in an active turn', () => {
    expect(isSubagentRunning(call({ status: 'completed' }), true)).toBe(false)
    expect(isSubagentRunning(call({ status: 'failed' }), true)).toBe(false)
  })

  it('stays running after the turn when the host still reports running', () => {
    const live = call({ status: 'in_progress', subagentLifecycle: { state: 'running' } })
    expect(isSubagentRunning(live, false)).toBe(true)
    expect(
      isSubagentRunning(
        call({ status: 'in_progress', subagentLifecycle: { state: 'completed' } }),
        true
      )
    ).toBe(false)
    expect(
      isSubagentRunning(call({ status: 'failed', subagentLifecycle: { state: 'running' } }), false)
    ).toBe(false)
  })
})
