import { describe, expect, it } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { sectionForTab } from './use-mobile-section'

const tabs = [
  { type: 'agent-chat', id: 'chat-1', sessionId: 's1' },
  { type: 'terminal', id: 'term-1', terminalId: 't1' },
  { type: 'terminal', id: 'term-2', terminalId: 't2' },
  { type: 'editor', id: 'edit-1', filePath: '/a.ts' },
  { type: 'git', id: 'git-1', cwd: '/p' },
  { type: 'browser', id: 'browser-1', browserTabId: 'b1' },
  { type: 'git-history', id: 'gh-1', cwd: '/p' },
  { type: 'diff', id: 'diff:1', cwd: '/p', path: 'a.ts', staged: false },
  { type: 'commit-diff', id: 'diff:2', cwd: '/p', commit: 'a'.repeat(40), path: 'a.ts' },
  {
    type: 'github-item',
    id: 'github-item-/p-origin-3',
    cwd: '/p',
    repo: 'origin',
    kind: 'issue',
    number: 3,
    title: 'Bug'
  }
] as WorkspaceTab[]

describe('sectionForTab', () => {
  it('maps every tab kind; Git History belongs to no section, Diff to Editors, a GitHub item to GitHub', () => {
    expect(tabs.map(sectionForTab)).toEqual([
      'chats',
      'terminals',
      'terminals',
      'editors',
      'editors',
      'editors',
      null,
      'editors',
      'editors',
      'github'
    ])
    expect(sectionForTab(null)).toBeNull()
  })
})
