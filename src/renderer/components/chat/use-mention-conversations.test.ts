import { describe, expect, it } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { projectConversations } from './use-mention-conversations'

const entry = (id: string, over: Parameters<typeof mockSessionIndexEntry>[0] = {}) =>
  mockSessionIndexEntry({ id, title: `Chat ${id}`, projectId: 'p1', ...over })

const conversations = (
  sessionIndex: ReturnType<typeof entry>[],
  excludeSessionId: string | null = null,
  runningIds: string[] = []
) =>
  projectConversations({
    sessionIndex,
    projectId: 'p1',
    excludeSessionId,
    agentNames: new Map(),
    runningIds: new Set(runningIds)
  })

describe('projectConversations', () => {
  it('lists a switched conversation once, on its terminal session', () => {
    const rows = conversations([
      entry('src', { lastActivityAt: 10 }),
      entry('dst', { continuedFrom: 'src', lastActivityAt: 20 })
    ])
    expect(rows.map((row) => row.sessionId)).toEqual(['dst'])
  })

  it('hides the merged conversation from a composer open on its pre-switch source', () => {
    const rows = conversations(
      [
        entry('src', { lastActivityAt: 10 }),
        entry('dst', { continuedFrom: 'src', lastActivityAt: 20 }),
        entry('other', { lastActivityAt: 5 })
      ],
      'src'
    )
    expect(rows.map((row) => row.sessionId)).toEqual(['other'])
  })

  it('keeps a source whose continuation sits in another project', () => {
    const rows = conversations([
      entry('src', { lastActivityAt: 10 }),
      entry('dst', { continuedFrom: 'src', projectId: 'p2', lastActivityAt: 20 })
    ])
    expect(rows.map((row) => row.sessionId)).toEqual(['src'])
  })

  it('shows the folded row running while any member runs', () => {
    const [row] = conversations(
      [
        entry('src', { lastActivityAt: 10 }),
        entry('dst', { continuedFrom: 'src', lastActivityAt: 20 })
      ],
      null,
      ['src']
    )
    expect(row).toMatchObject({ sessionId: 'dst', running: true })
  })
})
