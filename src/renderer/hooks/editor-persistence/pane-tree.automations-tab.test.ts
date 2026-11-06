import { describe, expect, it, vi } from 'vitest'
import { deserializePaneTree } from './pane-tree'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

describe('automations tab restore', () => {
  it('derives the tab id from the project, as the rail does, whatever id was stored', () => {
    const restored = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ type: 'automations', id: 'automations-stale', projectId: 'p1' }],
      activeTabId: 'automations-stale'
    })

    expect(restored).toEqual({
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ type: 'automations', id: 'automations-p1', projectId: 'p1' }],
      activeTabId: 'automations-p1'
    })
  })
})
