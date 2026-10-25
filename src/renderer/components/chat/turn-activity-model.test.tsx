import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import type { TimelineItem } from './chat-timeline'
import { turnActivityLabel, turnActivityModel, useTurnActivityOpen } from './turn-activity-model'

function narration(id: string, text: string): TimelineItem {
  const message: ChatMessage = {
    id,
    role: 'agent',
    blocks: [{ type: 'text', text }],
    streaming: false,
    timestamp: 0
  }
  return { kind: 'message', key: id, message }
}

function thought(id: string, text: string, streaming = false): TimelineItem {
  const message: ChatMessage = {
    id,
    role: 'thought',
    blocks: [{ type: 'text', text }],
    streaming,
    timestamp: 0
  }
  return { kind: 'thought-group', key: id, messages: [message] }
}

function command(id: string, cmd: string, status: ToolCall['status'] = 'completed'): TimelineItem {
  const tool: ToolCall = { toolCallId: id, title: cmd, kind: 'execute', status, rawInput: {} }
  return { kind: 'tool', key: id, tool }
}

function newFile(id: string, path: string, lines: string[]): TimelineItem {
  const tool: ToolCall = {
    toolCallId: id,
    title: path,
    kind: 'edit',
    status: 'completed',
    content: [{ type: 'diff', path, oldText: null, newText: `${lines.join('\n')}\n` }]
  }
  return { kind: 'tool', key: id, tool }
}

const message = (item: TimelineItem) => (item.kind === 'message' ? item.message : null)
const messages = (item: TimelineItem) => (item.kind === 'thought-group' ? item.messages : null)

describe('turnActivityModel', () => {
  it('rolls thoughts and tool calls between two narrations into one run, in order', () => {
    const a = narration('a', 'Narration A')
    const t1 = thought('t1', 'Look at the tests')
    const c1 = command('c1', 'npm test')
    const t2 = thought('t2', 'Lint next')
    const c2 = command('c2', 'npm run lint')
    const c3 = command('c3', 'npm run build')
    const b = narration('b', 'Narration B')

    expect(turnActivityModel([a, t1, c1, t2, c2, c3, b], false)).toEqual({
      entries: [
        { kind: 'message', key: 'a', message: message(a), isLast: false },
        {
          kind: 'work-run',
          key: 't1',
          items: [t1, c1, t2, c2, c3],
          summary: { label: 'Thought 2 times, ran 3 commands', added: 0, removed: 0 },
          failed: false,
          isLiveTail: false
        },
        { kind: 'message', key: 'b', message: message(b), isLast: false }
      ],
      summary: { label: 'Ran 3 commands', added: 0, removed: 0 }
    })
  })

  it('keeps a lone thought between two narrations as a bare thought', () => {
    const t1 = thought('t1', 'Just one idea')
    expect(
      turnActivityModel([narration('a', 'A'), t1, narration('b', 'B')], false).entries
    ).toEqual([
      { kind: 'message', key: 'a', message: message(narration('a', 'A')), isLast: false },
      { kind: 'thought', key: 't1', messages: messages(t1), isLiveTail: false },
      { kind: 'message', key: 'b', message: message(narration('b', 'B')), isLast: false }
    ])
  })

  it('marks the run that owns the last item as the live tail while active', () => {
    const t1 = thought('t1', 'Check the tests')
    const c1 = command('c1', 'npm test')
    const t2 = thought('t2', 'Now the build', true)
    const live = turnActivityModel([narration('a', 'A'), t1, c1, t2], true)
    expect(live.entries[1]).toEqual({
      kind: 'work-run',
      key: 't1',
      items: [t1, c1, t2],
      summary: { label: 'Thought 2 times, ran 1 command', added: 0, removed: 0 },
      failed: false,
      isLiveTail: true
    })
    expect(turnActivityModel([narration('a', 'A'), t1, c1, t2], false).entries[1]).toMatchObject({
      isLiveTail: false
    })
  })

  it('marks a streaming narration after a run as last, and a lone thought as live tail', () => {
    const c1 = command('c1', 'npm test')
    const m = narration('m', 'Running the tests now')
    expect(turnActivityModel([c1, m], true).entries).toEqual([
      {
        kind: 'work-run',
        key: 'c1',
        items: [c1],
        summary: { label: 'Ran 1 command', added: 0, removed: 0 },
        failed: false,
        isLiveTail: false
      },
      { kind: 'message', key: 'm', message: message(m), isLast: true }
    ])
    const t = thought('t', 'Hmm', true)
    expect(turnActivityModel([m, t], true).entries[1]).toEqual({
      kind: 'thought',
      key: 't',
      messages: messages(t),
      isLiveTail: true
    })
  })

  it('flags a run with a failed call and sums the diffstat across runs', () => {
    const f = newFile('f', 'src/a.ts', ['export const a = 1', 'export const b = 2'])
    const g = newFile('g', 'src/b.ts', ['export const c = 3'])
    const bad = command('x', 'npm test', 'failed')
    const model = turnActivityModel([f, narration('n', 'Now the test'), g, bad], false)
    expect(model.entries.map((entry) => [entry.kind, entry.key])).toEqual([
      ['work-run', 'f'],
      ['message', 'n'],
      ['work-run', 'g']
    ])
    expect(model.entries[0]).toMatchObject({
      summary: { label: 'Created 1 file', added: 2, removed: 0 },
      failed: false
    })
    expect(model.entries[2]).toMatchObject({
      summary: { label: 'Created 1 file, ran 1 command', added: 1, removed: 0 },
      failed: true
    })
    expect(model.summary).toEqual({ label: 'Created 2 files, ran 1 command', added: 3, removed: 0 })
  })

  it('is empty for a turn with nothing in it yet', () => {
    expect(turnActivityModel([], true)).toEqual({ entries: [], summary: null })
  })
})

describe('turnActivityLabel', () => {
  it('shows the status line while active, then how long the turn took', () => {
    expect(turnActivityLabel(true, null, 'Compacting context…')).toBe('Compacting context…')
    expect(turnActivityLabel(true, 5000, null)).toBe('Working…')
    expect(turnActivityLabel(false, 5000, 'Compacting context…')).toBe('Worked for 5s')
    expect(turnActivityLabel(false, null, null)).toBe('Worked')
  })
})

describe('useTurnActivityOpen', () => {
  type Props = { active: boolean; attention: boolean; final: boolean }
  const mount = (initial: Props) =>
    renderHook(
      ({ active, attention, final }: Props) => useTurnActivityOpen(active, attention, final),
      {
        initialProps: initial
      }
    )

  it('is open while active and closes once the turn settles with a reply', () => {
    const hook = mount({ active: true, attention: false, final: false })
    expect(hook.result.current[0]).toBe(true)
    hook.rerender({ active: false, attention: false, final: true })
    expect(hook.result.current[0]).toBe(false)
  })

  it('closes when the turn settles needing attention', () => {
    const hook = mount({ active: true, attention: false, final: false })
    hook.rerender({ active: false, attention: true, final: false })
    expect(hook.result.current[0]).toBe(false)
  })

  it('stays open when the turn settles with no reply and nothing to attend to', () => {
    const hook = mount({ active: true, attention: false, final: false })
    hook.rerender({ active: false, attention: false, final: false })
    expect(hook.result.current[0]).toBe(true)
  })

  it('mounts a settled turn closed, keeps the reader toggle, and re-opens when active again', () => {
    const hook = mount({ active: false, attention: false, final: true })
    expect(hook.result.current[0]).toBe(false)
    act(() => hook.result.current[1](true))
    expect(hook.result.current[0]).toBe(true)
    hook.rerender({ active: false, attention: false, final: true })
    expect(hook.result.current[0]).toBe(true)
    act(() => hook.result.current[1](false))
    hook.rerender({ active: true, attention: false, final: false })
    expect(hook.result.current[0]).toBe(true)
  })

  it('mounts a restored turn with no reply open', () => {
    expect(mount({ active: false, attention: false, final: false }).result.current[0]).toBe(true)
  })
})
