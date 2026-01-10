import { describe, it, expect, beforeEach } from 'vitest'
import { useCommandHistoryStore } from './command-history-store'

describe('command-history-store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useCommandHistoryStore.setState({ entries: [] })
  })

  describe('addCommand', () => {
    it('should add command to front of list', () => {
      const { addCommand } = useCommandHistoryStore.getState()

      addCommand({
        command: 'ls -la',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-1',
        timestamp: Date.now()
      })

      const entries = useCommandHistoryStore.getState().entries
      expect(entries).toHaveLength(1)
      expect(entries[0].command).toBe('ls -la')
    })

    it('should add new commands to front of list', () => {
      const { addCommand } = useCommandHistoryStore.getState()

      addCommand({
        command: 'cmd-1',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-1',
        timestamp: Date.now()
      })

      addCommand({
        command: 'cmd-2',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-1',
        timestamp: Date.now() + 1
      })

      const entries = useCommandHistoryStore.getState().entries
      expect(entries[0].command).toBe('cmd-2')
      expect(entries[1].command).toBe('cmd-1')
    })

    it('should generate unique IDs for each command', () => {
      const { addCommand } = useCommandHistoryStore.getState()

      addCommand({
        command: 'cmd-1',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-1',
        timestamp: Date.now()
      })

      addCommand({
        command: 'cmd-2',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-1',
        timestamp: Date.now()
      })

      const entries = useCommandHistoryStore.getState().entries
      expect(entries[0].id).not.toBe(entries[1].id)
    })
  })

  describe('clearHistory', () => {
    it('should clear commands for specified project only', () => {
      const { addCommand, clearHistory } = useCommandHistoryStore.getState()

      addCommand({
        command: 'cmd-proj1',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-1',
        timestamp: Date.now()
      })

      addCommand({
        command: 'cmd-proj2',
        terminalName: 'Terminal 1',
        terminalId: 'term-1',
        projectId: 'proj-2',
        timestamp: Date.now()
      })

      clearHistory('proj-1')

      const entries = useCommandHistoryStore.getState().entries
      expect(entries).toHaveLength(1)
      expect(entries[0].projectId).toBe('proj-2')
    })
  })

  describe('setHistory', () => {
    it('should overwrite the entire list', () => {
      const { setHistory } = useCommandHistoryStore.getState()

      const mockEntries = [
        {
          id: 'id-1',
          command: 'test-cmd',
          terminalName: 'Terminal 1',
          terminalId: 'term-1',
          projectId: 'proj-1',
          timestamp: Date.now()
        }
      ]

      setHistory(mockEntries)

      expect(useCommandHistoryStore.getState().entries).toEqual(mockEntries)
    })
  })
})
