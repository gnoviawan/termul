import { beforeEach, describe, expect, it } from 'vitest'
import { resetTerminalStore, seedTerminalStore } from '@/lib/test-utils/store'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { hasActiveTerminalSessions } from '../tauri-safe-update'

describe('tauri-safe-update', () => {
  beforeEach(() => {
    resetTerminalStore()
  })

  it('returns false when there are no terminals', () => {
    expect(hasActiveTerminalSessions()).toBe(false)
  })

  it('returns false when all terminals are hidden', () => {
    seedTerminalStore([
      mockTerminal({
        id: 't1',
        name: 'Hidden 1',
        projectId: 'p1',
        isHidden: true,
        healthStatus: 'running'
      }),
      mockTerminal({
        id: 't2',
        name: 'Hidden 2',
        projectId: 'p1',
        isHidden: true,
        healthStatus: 'running'
      })
    ])

    expect(hasActiveTerminalSessions()).toBe(false)
  })

  it('returns false when terminals are hibernated', () => {
    seedTerminalStore([
      mockTerminal({
        id: 't1',
        name: 'Hibernated',
        projectId: 'p1',
        isHidden: false,
        healthStatus: 'hibernated'
      })
    ])

    expect(hasActiveTerminalSessions()).toBe(false)
  })

  it('returns true when at least one visible non-hibernated terminal exists', () => {
    seedTerminalStore([
      mockTerminal({
        id: 't1',
        name: 'Visible',
        projectId: 'p1',
        isHidden: false,
        healthStatus: 'running'
      }),
      mockTerminal({
        id: 't2',
        name: 'Hidden',
        projectId: 'p1',
        isHidden: true,
        healthStatus: 'running'
      })
    ])

    expect(hasActiveTerminalSessions()).toBe(true)
  })
})
