import { describe, it, expect, beforeEach } from 'vitest'
import { useRecentCommandsStore } from './recent-commands-store'

describe('recent-commands-store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useRecentCommandsStore.setState({ recentCommandIds: [] })
  })

  describe('addRecentCommand', () => {
    it('should add command to front of list', () => {
      const { addRecentCommand } = useRecentCommandsStore.getState()

      addRecentCommand('cmd-1')
      expect(useRecentCommandsStore.getState().recentCommandIds).toEqual(['cmd-1'])

      addRecentCommand('cmd-2')
      expect(useRecentCommandsStore.getState().recentCommandIds).toEqual(['cmd-2', 'cmd-1'])
    })

    it('should move existing command to front (no duplicates)', () => {
      const { addRecentCommand, setRecentCommands } = useRecentCommandsStore.getState()

      setRecentCommands(['cmd-1', 'cmd-2', 'cmd-3'])
      addRecentCommand('cmd-2')

      expect(useRecentCommandsStore.getState().recentCommandIds).toEqual(['cmd-2', 'cmd-1', 'cmd-3'])
    })

    it('should enforce MAX_RECENT_COMMANDS limit of 5', () => {
      const { addRecentCommand } = useRecentCommandsStore.getState()

      // Add 6 commands
      addRecentCommand('cmd-1')
      addRecentCommand('cmd-2')
      addRecentCommand('cmd-3')
      addRecentCommand('cmd-4')
      addRecentCommand('cmd-5')
      addRecentCommand('cmd-6')

      const ids = useRecentCommandsStore.getState().recentCommandIds
      expect(ids).toHaveLength(5)
      expect(ids).toEqual(['cmd-6', 'cmd-5', 'cmd-4', 'cmd-3', 'cmd-2'])
      expect(ids).not.toContain('cmd-1') // cmd-1 was pushed out
    })
  })

  describe('setRecentCommands', () => {
    it('should overwrite the entire list', () => {
      const { setRecentCommands } = useRecentCommandsStore.getState()

      setRecentCommands(['a', 'b', 'c'])
      expect(useRecentCommandsStore.getState().recentCommandIds).toEqual(['a', 'b', 'c'])

      setRecentCommands(['x', 'y'])
      expect(useRecentCommandsStore.getState().recentCommandIds).toEqual(['x', 'y'])
    })

    it('should allow setting empty list', () => {
      const { setRecentCommands } = useRecentCommandsStore.getState()

      setRecentCommands(['a', 'b'])
      setRecentCommands([])

      expect(useRecentCommandsStore.getState().recentCommandIds).toEqual([])
    })
  })
})
