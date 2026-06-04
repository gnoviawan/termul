import { describe, expect, it } from 'vitest'
import type { PermissionOption } from '@/lib/acp-api'
import {
  diffLineCounts,
  diffLines,
  isAllowOption,
  isRejectOption,
  kindIcon,
  pickRejectOption,
  statusStyle
} from './tool-call-format'

describe('kindIcon', () => {
  it('maps known kinds', () => {
    expect(kindIcon('read')).toBe('read')
    expect(kindIcon('edit')).toBe('edit')
    expect(kindIcon('execute')).toBe('execute')
    expect(kindIcon('switch_mode')).toBe('switch')
  })
  it('falls back to a generic tool icon for unknown/undefined', () => {
    expect(kindIcon('frobnicate')).toBe('tool')
    expect(kindIcon(undefined)).toBe('tool')
  })
})

describe('statusStyle', () => {
  it('marks in_progress as spinning', () => {
    expect(statusStyle('in_progress').spinning).toBe(true)
  })
  it('completed/failed/pending are not spinning', () => {
    expect(statusStyle('completed').spinning).toBe(false)
    expect(statusStyle('failed').spinning).toBe(false)
    expect(statusStyle('pending').spinning).toBe(false)
    expect(statusStyle(undefined).label).toBe('pending')
  })
})

describe('diffLines / diffLineCounts', () => {
  it('emits removed lines then added lines', () => {
    const lines = diffLines({ oldText: 'a\nb', newText: 'a\nc' })
    expect(lines).toEqual([
      { type: 'removed', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'a' },
      { type: 'added', text: 'c' }
    ])
  })
  it('treats absent oldText as a new file', () => {
    const lines = diffLines({ oldText: null, newText: 'x\ny' })
    expect(lines.every((l) => l.type === 'added')).toBe(true)
    expect(diffLineCounts({ oldText: null, newText: 'x\ny' })).toEqual({ added: 2, removed: 0 })
  })
  it('skips an empty side entirely', () => {
    expect(diffLines({ oldText: 'a', newText: '' })).toEqual([{ type: 'removed', text: 'a' }])
  })
  it('strips trailing CR from CRLF lines', () => {
    expect(diffLines({ oldText: null, newText: 'a\r\nb' })).toEqual([
      { type: 'added', text: 'a' },
      { type: 'added', text: 'b' }
    ])
  })
  it('counts both sides', () => {
    expect(diffLineCounts({ oldText: 'a\nb\nc', newText: 'a' })).toEqual({ added: 1, removed: 3 })
  })
  it('ignores the trailing empty segment for newline-terminated text', () => {
    expect(diffLines({ oldText: 'a\n', newText: 'b\n' })).toEqual([
      { type: 'removed', text: 'a' },
      { type: 'added', text: 'b' }
    ])
    expect(diffLineCounts({ oldText: 'a\n', newText: 'b\n' })).toEqual({ added: 1, removed: 1 })
  })
})

describe('permission option helpers', () => {
  const options: PermissionOption[] = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' }
  ]
  it('classifies allow vs reject', () => {
    expect(isAllowOption(options[0])).toBe(true)
    expect(isRejectOption(options[0])).toBe(false)
    expect(isRejectOption(options[2])).toBe(true)
  })
  it('picks a reject option when present, null otherwise', () => {
    expect(pickRejectOption(options)?.optionId).toBe('r1')
    expect(pickRejectOption(options.slice(0, 2))).toBeNull()
  })
})
