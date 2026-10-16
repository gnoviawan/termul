import { describe, expect, it, vi } from 'vitest'
import { serializePaneTree } from '@/hooks/editor-persistence/pane-tree'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'
import { isWorkspaceTabKind, WORKSPACE_TAB_KIND_TRAITS } from './workspace-tab-kinds'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn().mockResolvedValue(undefined)
}))

const SAMPLE_TABS: Record<WorkspaceTab['type'], WorkspaceTab> = {
  terminal: { type: 'terminal', id: 'terminal:t1', terminalId: 't1' },
  editor: { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
  browser: { type: 'browser', id: 'browser:b1', browserTabId: 'b1' },
  git: { type: 'git', id: 'git-1', cwd: '/repo' },
  'agent-chat': { type: 'agent-chat', id: 'chat-s1', sessionId: 's1' },
  'git-history': { type: 'git-history', id: 'gh-1', cwd: '/repo' },
  diff: { type: 'diff', id: 'diff:abc', cwd: '/repo', path: 'src/a.ts', staged: false },
  'commit-diff': {
    type: 'commit-diff',
    id: 'diff:def',
    cwd: '/repo',
    commit: 'e44b917'.padEnd(40, '0'),
    path: 'src/a.ts'
  },
  canvas: { type: 'canvas', id: 'canvas-1', projectId: 'p', docPath: '/d.op' }
}

const kinds = Object.keys(WORKSPACE_TAB_KIND_TRAITS) as WorkspaceTab['type'][]

const leafWith = (tab: WorkspaceTab): LeafNode => ({
  type: 'leaf',
  id: 'pane-1',
  tabs: [tab],
  activeTabId: tab.id
})

describe('WORKSPACE_TAB_KIND_TRAITS', () => {
  it('has a sample tab for every declared kind', () => {
    expect([...kinds].sort()).toEqual(Object.keys(SAMPLE_TABS).sort())
  })

  it.each(kinds)('%s: workspace record serialization matches the persisted trait', (kind) => {
    const serialized = serializePaneTree(leafWith(SAMPLE_TABS[kind]))
    if (serialized.type !== 'leaf') throw new Error('expected leaf')
    const persisted = serialized.tabs.length > 0
    expect(persisted).toBe(WORKSPACE_TAB_KIND_TRAITS[kind].persisted)
    if (persisted) expect(serialized.tabs[0].type).toBe(kind)
  })

  it('declares diff as persisted', () => {
    expect(WORKSPACE_TAB_KIND_TRAITS.diff).toEqual({ persisted: true })
  })

  it('declares commit-diff as persisted', () => {
    expect(WORKSPACE_TAB_KIND_TRAITS['commit-diff']).toEqual({ persisted: true })
  })

  it('declares canvas as not persisted', () => {
    expect(WORKSPACE_TAB_KIND_TRAITS.canvas).toEqual({ persisted: false })
  })
})

describe('isWorkspaceTabKind', () => {
  it.each(kinds)('accepts %s', (kind) => {
    expect(isWorkspaceTabKind(kind)).toBe(true)
  })

  it.each(['', 'toString', '__proto__', undefined, null, 42, {}])('rejects %j', (value) => {
    expect(isWorkspaceTabKind(value)).toBe(false)
  })
})
