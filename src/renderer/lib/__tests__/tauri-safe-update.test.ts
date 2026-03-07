import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore } from '@/stores/terminal-store'
import { hasActiveTerminalSessions } from '../tauri-safe-update'

describe('tauri-safe-update', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: ''
    })
  })

  it('returns false when there are no terminals', () => {
    expect(hasActiveTerminalSessions()).toBe(false)
  })

  it('returns false when all terminals are hidden', () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: 't1',
          name: 'Hidden 1',
          projectId: 'p1',
          shell: 'bash',
          isHidden: true,
          healthStatus: 'running'
        },
        {
          id: 't2',
          name: 'Hidden 2',
          projectId: 'p1',
          shell: 'bash',
          isHidden: true,
          healthStatus: 'running'
        }
      ]
    })

    expect(hasActiveTerminalSessions()).toBe(false)
  })

  it('returns false when terminals are hibernated', () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: 't1',
          name: 'Hibernated',
          projectId: 'p1',
          shell: 'bash',
          isHidden: false,
          healthStatus: 'hibernated'
        }
      ]
    })

    expect(hasActiveTerminalSessions()).toBe(false)
  })

  it('returns true when at least one visible non-hibernated terminal exists', () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: 't1',
          name: 'Visible',
          projectId: 'p1',
          shell: 'bash',
          isHidden: false,
          healthStatus: 'running'
        },
        {
          id: 't2',
          name: 'Hidden',
          projectId: 'p1',
          shell: 'bash',
          isHidden: true,
          healthStatus: 'running'
        }
      ]
    })

    expect(hasActiveTerminalSessions()).toBe(true)
  })
})
