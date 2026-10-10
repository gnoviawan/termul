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
  { type: 'git-history', id: 'gh-1', cwd: '/p' }
] as WorkspaceTab[]

describe('sectionForTab', () => {
  it('maps every tab kind; Git History belongs to no section', () => {
    expect(tabs.map(sectionForTab)).toEqual([
      'chats',
      'terminals',
      'terminals',
      'editors',
      'editors',
      'editors',
      null
    ])
    expect(sectionForTab(null)).toBeNull()
  })
})
