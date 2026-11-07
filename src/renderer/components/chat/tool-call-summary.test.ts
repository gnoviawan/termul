import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  endedState,
  type SubagentRecordOverrides,
  subagentToolCall
} from '@/lib/test-utils/subagent'
import {
  baseName,
  describeToolCall,
  isSubagentCall,
  isSubagentRunning,
  readableOutput,
  summarizeToolActivity,
  toolCallChangedPaths,
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

  it('renders a subagent call as the record title with no verb', () => {
    const s = describeToolCall(subagentToolCall({ title: 'Find chat response cursor rendering' }))
    expect(s).toEqual({
      verb: '',
      primary: 'Find chat response cursor rendering',
      detail: null
    })
  })

  it('renders a subagent control call as its title, else "Agent command"', () => {
    const control = { subagentControl: { subagentIds: [] } }
    expect(describeToolCall(call({ title: 'wait', ...control }))).toEqual({
      verb: '',
      primary: 'wait',
      detail: null
    })
    expect(describeToolCall(call({ kind: 'other', ...control })).primary).toBe('Agent command')
  })

  it('no longer guesses a subagent from rawInput', () => {
    const s = describeToolCall(
      call({ kind: 'think', title: 'Task', rawInput: { description: 'd', prompt: 'p' } })
    )
    expect(s.verb).toBe('Thinking')
  })

  it('still renders a genuine think call as "Thinking"', () => {
    const s = describeToolCall(call({ kind: 'think', rawInput: { thought: 'pondering' } }))
    expect(s).toEqual({ verb: 'Thinking', primary: 'pondering', detail: null })
  })
})

describe('isSubagentCall', () => {
  it('is true only when the host attached a record', () => {
    expect(isSubagentCall(subagentToolCall())).toBe(true)
    expect(isSubagentCall(call({ rawInput: { subagent_type: 'explore', prompt: 'p' } }))).toBe(
      false
    )
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
  const subagent = (record?: SubagentRecordOverrides): ToolCall => subagentToolCall(record)

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

  it('counts a background subagent as a background agent', () => {
    expect(summarizeToolActivity([subagent({ background: true })])?.label).toBe(
      'Ran 1 background agent'
    )
    expect(
      summarizeToolActivity([subagent({ background: true }), subagent({ background: true })])?.label
    ).toBe('Ran 2 background agents')
  })

  it('counts a subagent control call as an agent command', () => {
    const control = call({ title: 'wait', subagentControl: { subagentIds: [] } })
    expect(summarizeToolActivity([control])?.label).toBe('Sent 1 agent command')
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

describe('toolCallChangedPaths', () => {
  it('claims every diff path of a multi-file edit without locations', () => {
    const paths = toolCallChangedPaths(
      call({
        kind: 'edit',
        content: [
          { type: 'diff', path: 'src/a.ts', newText: 'a' },
          { type: 'content', content: { type: 'text', text: 'note' } },
          { type: 'diff', path: ' src/b.ts ', newText: 'b' },
          { type: 'diff', path: '  ', newText: 'x' },
          { type: 'diff', path: 'src/a.ts', newText: 'aa' }
        ]
      })
    )
    expect(paths).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('puts the toolCallPath first, then every location, then the diff paths', () => {
    const paths = toolCallChangedPaths(
      call({
        kind: 'move',
        rawInput: { path: 'src/input.ts' },
        locations: [{ path: 'src/old.ts' }, { path: 'src/new.ts' }],
        content: [{ type: 'diff', path: 'src/diff.ts', newText: 'x' }]
      })
    )
    expect(paths).toEqual(['src/old.ts', 'src/new.ts', 'src/diff.ts'])
    expect(
      toolCallChangedPaths(call({ kind: 'edit', rawInput: { path: 'src/input.ts' } }))
    ).toEqual(['src/input.ts'])
    expect(toolCallChangedPaths(call({ kind: 'edit' }))).toEqual([])
  })
})

describe('isSubagentRunning', () => {
  const dispatch = (partial: Partial<ToolCall> = {}, record: SubagentRecordOverrides = {}) =>
    subagentToolCall(record, partial)
  const background = (partial: Partial<ToolCall> = {}, record: SubagentRecordOverrides = {}) =>
    dispatch({ status: 'completed', ...partial }, { background: true, ...record })

  it('is false without a record', () => {
    expect(isSubagentRunning(call({ status: 'in_progress' }), 'active')).toBe(false)
  })

  it('runs a foreground dispatch only while its turn is active', () => {
    expect(isSubagentRunning(dispatch({ status: 'pending' }), 'active')).toBe(true)
    expect(isSubagentRunning(dispatch({ status: undefined }), 'active')).toBe(true)
    // A cancelled or crashed turn can leave the dispatch in flight forever.
    expect(isSubagentRunning(dispatch({ status: 'in_progress' }), 'ended')).toBe(false)
    expect(isSubagentRunning(dispatch({ status: 'in_progress' }), 'superseded')).toBe(false)
  })

  it('is not running once idle or unknown, even in an active turn', () => {
    for (const reason of ['completed', 'failed', 'cancelled', 'unexplained'] as const) {
      expect(isSubagentRunning(dispatch({}, { state: endedState(reason) }), 'active')).toBe(false)
    }
    expect(isSubagentRunning(dispatch({}, { state: { activity: 'unknown' } }), 'active')).toBe(
      false
    )
  })

  it('counts waiting for input as running', () => {
    const waiting = dispatch({}, { state: { activity: 'requires_action' } })
    expect(isSubagentRunning(waiting, 'active')).toBe(true)
  })

  it('keeps a background launch running after its turn ends, until a newer turn starts', () => {
    expect(isSubagentRunning(background(), 'active')).toBe(true)
    expect(isSubagentRunning(background(), 'ended')).toBe(true)
    expect(isSubagentRunning(background(), 'superseded')).toBe(false)
  })

  it('treats a background launch without a launch receipt as foreground', () => {
    // Stop before the receipt leaves the launch pending with nothing to outlive the turn.
    for (const status of ['pending', 'in_progress', undefined] as const) {
      expect(isSubagentRunning(background({ status }), 'active')).toBe(true)
      expect(isSubagentRunning(background({ status }), 'ended')).toBe(false)
      expect(isSubagentRunning(background({ status }), 'superseded')).toBe(false)
    }
  })

  it('stays running in any turn while a live source reports running', () => {
    const live = dispatch({ status: 'in_progress' }, { caps: { liveProgress: true } })
    expect(isSubagentRunning(live, 'ended')).toBe(true)
    expect(isSubagentRunning(live, 'superseded')).toBe(true)
    const ended = dispatch({}, { caps: { liveProgress: true }, state: endedState('completed') })
    expect(isSubagentRunning(ended, 'active')).toBe(false)
  })
})
