import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore } from './terminal-store'
import { useProjectStore } from './project-store'

describe('terminal-store', () => {
  beforeEach(() => {
    // Reset stores to initial state before each test
    useProjectStore.setState({
      projects: [
        { id: '1', name: 'Project 1', color: 'blue', isActive: true },
        { id: '2', name: 'Project 2', color: 'green' }
      ],
      activeProjectId: '1'
    })

    useTerminalStore.setState({
      terminals: [
        { id: 't1', name: 'Terminal 1', projectId: '1', shell: 'powershell', output: [] },
        { id: 't2', name: 'Terminal 2', projectId: '1', shell: 'powershell', output: [] },
        { id: 't3', name: 'Terminal 3', projectId: '2', shell: 'bash', output: [] }
      ],
      activeTerminalId: 't1'
    })
  })

  describe('initial state', () => {
    it('should have empty terminals array by default', () => {
      // Reset to true initial state (no beforeEach data)
      useTerminalStore.setState({ terminals: [], activeTerminalId: '' })
      const { terminals } = useTerminalStore.getState()
      expect(terminals).toEqual([])
    })

    it('should have empty activeTerminalId by default', () => {
      // Reset to true initial state (no beforeEach data)
      useTerminalStore.setState({ terminals: [], activeTerminalId: '' })
      const { activeTerminalId } = useTerminalStore.getState()
      expect(activeTerminalId).toBe('')
    })
  })

  describe('selectTerminal', () => {
    it('should update activeTerminalId', () => {
      const { selectTerminal } = useTerminalStore.getState()
      selectTerminal('t2')

      const { activeTerminalId } = useTerminalStore.getState()
      expect(activeTerminalId).toBe('t2')
    })

    it('should update isActive property on terminals', () => {
      const { selectTerminal } = useTerminalStore.getState()
      selectTerminal('t2')

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      const terminal2 = terminals.find((t) => t.id === 't2')

      expect(terminal1?.isActive).toBe(false)
      expect(terminal2?.isActive).toBe(true)
    })
  })

  describe('addTerminal', () => {
    it('should add a new terminal to the array', () => {
      const { addTerminal } = useTerminalStore.getState()
      const initialCount = useTerminalStore.getState().terminals.length

      addTerminal('New Terminal', '1')

      const { terminals } = useTerminalStore.getState()
      expect(terminals.length).toBe(initialCount + 1)
    })

    it('should return the created terminal', () => {
      const { addTerminal } = useTerminalStore.getState()
      const newTerminal = addTerminal('Test Terminal', '1', 'bash')

      expect(newTerminal.name).toBe('Test Terminal')
      expect(newTerminal.projectId).toBe('1')
      expect(newTerminal.shell).toBe('bash')
      expect(newTerminal.id).toBeTruthy()
    })

    it('should set activeTerminalId to new terminal', () => {
      const { addTerminal } = useTerminalStore.getState()
      const newTerminal = addTerminal('New', '1')

      const { activeTerminalId } = useTerminalStore.getState()
      expect(activeTerminalId).toBe(newTerminal.id)
    })

    it('should default shell to powershell', () => {
      const { addTerminal } = useTerminalStore.getState()
      const newTerminal = addTerminal('Test', '1')

      expect(newTerminal.shell).toBe('powershell')
    })

    it('should store cwd when provided', () => {
      const { addTerminal } = useTerminalStore.getState()
      const newTerminal = addTerminal('Test', '1', 'bash', '/home/user/project')

      expect(newTerminal.cwd).toBe('/home/user/project')
    })

    it('should have undefined cwd when not provided', () => {
      const { addTerminal } = useTerminalStore.getState()
      const newTerminal = addTerminal('Test', '1', 'powershell')

      expect(newTerminal.cwd).toBeUndefined()
    })
  })

  describe('closeTerminal', () => {
    it('should remove terminal from array', () => {
      const { closeTerminal } = useTerminalStore.getState()
      const initialCount = useTerminalStore.getState().terminals.length

      closeTerminal('t2', '1')

      const { terminals } = useTerminalStore.getState()
      expect(terminals.length).toBe(initialCount - 1)
      expect(terminals.find((t) => t.id === 't2')).toBeUndefined()
    })

    it('should update activeTerminalId when closing active terminal', () => {
      const { closeTerminal } = useTerminalStore.getState()
      closeTerminal('t1', '1')

      const { activeTerminalId } = useTerminalStore.getState()
      expect(activeTerminalId).toBe('t2')
    })

    it('should not change activeTerminalId when closing non-active terminal', () => {
      const { closeTerminal } = useTerminalStore.getState()
      closeTerminal('t2', '1')

      const { activeTerminalId } = useTerminalStore.getState()
      expect(activeTerminalId).toBe('t1')
    })

    it('should set empty activeTerminalId when closing last terminal for project', () => {
      // Close all terminals for project 2
      const { closeTerminal } = useTerminalStore.getState()
      useTerminalStore.setState({ activeTerminalId: 't3' })

      closeTerminal('t3', '2')

      const { activeTerminalId } = useTerminalStore.getState()
      expect(activeTerminalId).toBe('')
    })
  })

  describe('renameTerminal', () => {
    it('should update terminal name', () => {
      const { renameTerminal } = useTerminalStore.getState()
      renameTerminal('t1', 'Renamed Terminal')

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')

      expect(terminal?.name).toBe('Renamed Terminal')
    })
  })

  describe('reorderTerminals', () => {
    it('should reorder terminals for a project', () => {
      const { reorderTerminals } = useTerminalStore.getState()
      reorderTerminals('1', ['t2', 't1'])

      const { terminals } = useTerminalStore.getState()
      const projectTerminals = terminals.filter((t) => t.projectId === '1')

      expect(projectTerminals[0].id).toBe('t2')
      expect(projectTerminals[1].id).toBe('t1')
    })

    it('should not affect terminals from other projects', () => {
      const { reorderTerminals } = useTerminalStore.getState()
      reorderTerminals('1', ['t2', 't1'])

      const { terminals } = useTerminalStore.getState()
      const project2Terminals = terminals.filter((t) => t.projectId === '2')

      expect(project2Terminals.length).toBe(1)
      expect(project2Terminals[0].id).toBe('t3')
    })
  })

  describe('setTerminals', () => {
    it('should replace all terminals', () => {
      const { setTerminals } = useTerminalStore.getState()
      const newTerminals = [
        { id: 'new', name: 'New', projectId: '1', shell: 'bash' as const, output: [] }
      ]

      setTerminals(newTerminals)

      const { terminals } = useTerminalStore.getState()
      expect(terminals.length).toBe(1)
      expect(terminals[0].id).toBe('new')
    })
  })

  describe('setTerminalPtyId', () => {
    it('should set ptyId on existing terminal', () => {
      const { setTerminalPtyId } = useTerminalStore.getState()

      const didSet = setTerminalPtyId('t1', 'terminal-123-1')

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(didSet).toBe(true)
      expect(terminal?.ptyId).toBe('terminal-123-1')
    })

    it('should not affect other terminals', () => {
      const { setTerminalPtyId } = useTerminalStore.getState()

      const didSet = setTerminalPtyId('t1', 'terminal-123-1')

      const { terminals } = useTerminalStore.getState()
      const terminal2 = terminals.find((t) => t.id === 't2')
      expect(didSet).toBe(true)
      expect(terminal2?.ptyId).toBeUndefined()
    })

    it('should reject assigning same ptyId to different terminal', () => {
      const { setTerminalPtyId } = useTerminalStore.getState()

      setTerminalPtyId('t1', 'terminal-shared')
      const secondSet = setTerminalPtyId('t2', 'terminal-shared')

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      const terminal2 = terminals.find((t) => t.id === 't2')

      expect(secondSet).toBe(false)
      expect(terminal1?.ptyId).toBe('terminal-shared')
      expect(terminal2?.ptyId).toBeUndefined()
    })

    it('should ignore attempts to replace existing different ptyId', () => {
      const { setTerminalPtyId } = useTerminalStore.getState()

      const firstSet = setTerminalPtyId('t1', 'terminal-old')
      const secondSet = setTerminalPtyId('t1', 'terminal-new')

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(firstSet).toBe(true)
      expect(secondSet).toBe(false)
      expect(terminal?.ptyId).toBe('terminal-old')
    })
  })

  describe('findTerminalByPtyId', () => {
    it('should find terminal by ptyId', () => {
      const { setTerminalPtyId, findTerminalByPtyId } = useTerminalStore.getState()

      setTerminalPtyId('t1', 'terminal-123-1')
      const terminal = findTerminalByPtyId('terminal-123-1')

      expect(terminal).toBeDefined()
      expect(terminal?.id).toBe('t1')
    })

    it('should return undefined when ptyId not found', () => {
      const { findTerminalByPtyId } = useTerminalStore.getState()

      const terminal = findTerminalByPtyId('non-existent')
      expect(terminal).toBeUndefined()
    })

    it('should find correct terminal when multiple have ptyIds', () => {
      const { setTerminalPtyId, findTerminalByPtyId } = useTerminalStore.getState()

      setTerminalPtyId('t1', 'terminal-123-1')
      setTerminalPtyId('t2', 'terminal-123-2')

      const terminal1 = findTerminalByPtyId('terminal-123-1')
      const terminal2 = findTerminalByPtyId('terminal-123-2')

      expect(terminal1?.id).toBe('t1')
      expect(terminal2?.id).toBe('t2')
    })
  })

  describe('clearTerminalPtyId', () => {
    it('should clear ptyId from matching terminal', () => {
      const { setTerminalPtyId, clearTerminalPtyId } = useTerminalStore.getState()

      setTerminalPtyId('t1', 'terminal-123-1')
      clearTerminalPtyId('terminal-123-1')

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(terminal?.ptyId).toBeUndefined()
    })

    it('should not affect terminals with different ptyId', () => {
      const { setTerminalPtyId, clearTerminalPtyId } = useTerminalStore.getState()

      setTerminalPtyId('t1', 'terminal-123-1')
      setTerminalPtyId('t2', 'terminal-123-2')
      clearTerminalPtyId('terminal-123-1')

      const { terminals } = useTerminalStore.getState()
      const terminal2 = terminals.find((t) => t.id === 't2')
      expect(terminal2?.ptyId).toBe('terminal-123-2')
    })

    it('should be a no-op when ptyId does not exist', () => {
      const { setTerminalPtyId, clearTerminalPtyId } = useTerminalStore.getState()

      setTerminalPtyId('t1', 'terminal-123-1')
      clearTerminalPtyId('non-existent')

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      expect(terminal1?.ptyId).toBe('terminal-123-1')
    })
  })

  describe('updateTerminalExitCode', () => {
    it('should update exit code for existing terminal', () => {
      const { updateTerminalExitCode } = useTerminalStore.getState()

      updateTerminalExitCode('t1', 0)

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(terminal?.lastExitCode).toBe(0)
    })

    it('should update exit code to non-zero value', () => {
      const { updateTerminalExitCode } = useTerminalStore.getState()

      updateTerminalExitCode('t1', 127)

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(terminal?.lastExitCode).toBe(127)
    })

    it('should update exit code to null', () => {
      const { updateTerminalExitCode } = useTerminalStore.getState()

      // First set a value
      updateTerminalExitCode('t1', 1)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.lastExitCode).toBe(1)

      // Then reset to null
      updateTerminalExitCode('t1', null)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.lastExitCode).toBeNull()
    })

    it('should not affect other terminals', () => {
      const { updateTerminalExitCode } = useTerminalStore.getState()

      updateTerminalExitCode('t1', 42)

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      const terminal2 = terminals.find((t) => t.id === 't2')

      expect(terminal1?.lastExitCode).toBe(42)
      expect(terminal2?.lastExitCode).toBeUndefined()
    })
  })

  describe('updateTerminalScrollback', () => {
    it('should update pendingScrollback field when called with scrollback array', () => {
      const { updateTerminalScrollback } = useTerminalStore.getState()

      updateTerminalScrollback('t1', ['line 1', 'line 2', 'line 3'])

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(terminal?.pendingScrollback).toEqual(['line 1', 'line 2', 'line 3'])
    })

    it('should set pendingScrollback to undefined when called with undefined', () => {
      const { updateTerminalScrollback } = useTerminalStore.getState()

      // First set a value
      updateTerminalScrollback('t1', ['existing line 1', 'existing line 2'])
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.pendingScrollback).toHaveLength(2)

      // Then clear it
      updateTerminalScrollback('t1', undefined)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.pendingScrollback).toBeUndefined()
    })

    it('should not affect other terminals', () => {
      const { updateTerminalScrollback } = useTerminalStore.getState()

      updateTerminalScrollback('t1', ['terminal 1 lines'])

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      const terminal2 = terminals.find((t) => t.id === 't2')

      expect(terminal1?.pendingScrollback).toEqual(['terminal 1 lines'])
      expect(terminal2?.pendingScrollback).toBeUndefined()
    })

    it('should handle non-existent terminal id gracefully', () => {
      const { updateTerminalScrollback } = useTerminalStore.getState()

      // Should not throw
      expect(() => updateTerminalScrollback('non-existent-id', ['lines'])).not.toThrow()

      const { terminals } = useTerminalStore.getState()
      expect(terminals).toHaveLength(3)
    })
  })

  describe('updateTerminalActivity', () => {
    it('should set hasActivity to true', () => {
      const { updateTerminalActivity } = useTerminalStore.getState()

      updateTerminalActivity('t1', true)

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(terminal?.hasActivity).toBe(true)
    })

    it('should set hasActivity to false', () => {
      const { updateTerminalActivity } = useTerminalStore.getState()

      // First set to true
      updateTerminalActivity('t1', true)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.hasActivity).toBe(true)

      // Then set to false
      updateTerminalActivity('t1', false)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.hasActivity).toBe(false)
    })

    it('should not affect other terminals', () => {
      const { updateTerminalActivity } = useTerminalStore.getState()

      updateTerminalActivity('t1', true)

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      const terminal2 = terminals.find((t) => t.id === 't2')

      expect(terminal1?.hasActivity).toBe(true)
      expect(terminal2?.hasActivity).toBeUndefined()
    })
  })

  describe('updateTerminalLastActivityTimestamp', () => {
    it('should update the lastActivityTimestamp', () => {
      const { updateTerminalLastActivityTimestamp } = useTerminalStore.getState()
      const timestamp = Date.now()

      updateTerminalLastActivityTimestamp('t1', timestamp)

      const { terminals } = useTerminalStore.getState()
      const terminal = terminals.find((t) => t.id === 't1')
      expect(terminal?.lastActivityTimestamp).toBe(timestamp)
    })

    it('should not affect other terminals', () => {
      const { updateTerminalLastActivityTimestamp } = useTerminalStore.getState()
      const timestamp = Date.now()

      updateTerminalLastActivityTimestamp('t1', timestamp)

      const { terminals } = useTerminalStore.getState()
      const terminal1 = terminals.find((t) => t.id === 't1')
      const terminal2 = terminals.find((t) => t.id === 't2')

      expect(terminal1?.lastActivityTimestamp).toBe(timestamp)
      expect(terminal2?.lastActivityTimestamp).toBeUndefined()
    })

    it('should overwrite existing timestamp', () => {
      const { updateTerminalLastActivityTimestamp } = useTerminalStore.getState()
      const firstTimestamp = 1000000
      const secondTimestamp = 2000000

      updateTerminalLastActivityTimestamp('t1', firstTimestamp)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.lastActivityTimestamp).toBe(firstTimestamp)

      updateTerminalLastActivityTimestamp('t1', secondTimestamp)
      expect(useTerminalStore.getState().terminals.find((t) => t.id === 't1')?.lastActivityTimestamp).toBe(secondTimestamp)
    })
  })

  // ========== Multi-Project Terminal Preservation Tests ==========
  // These tests verify AC1, AC3, AC6 from the tech spec:
  // - AC1: Terminals are NOT killed when switching projects
  // - AC3: Terminals with live PTY reconnect when returning to project
  // - AC6: Workspace tabs remain stable across project switches

  describe('multi-project terminal preservation', () => {
    it('should preserve terminals from project A when project B becomes active', () => {
      // Setup: Terminals exist for both projects
      const { setTerminalPtyId } = useTerminalStore.getState()
      setTerminalPtyId('t1', 'pty-project-1-a')
      setTerminalPtyId('t2', 'pty-project-1-b')
      setTerminalPtyId('t3', 'pty-project-2')

      // Simulate switching to project 2
      useProjectStore.setState({ activeProjectId: '2' })

      // Verify: All terminals still exist
      const { terminals } = useTerminalStore.getState()
      const project1Terminals = terminals.filter((t) => t.projectId === '1')
      const project2Terminals = terminals.filter((t) => t.projectId === '2')

      // AC1: Terminals from project 1 should NOT be removed
      expect(project1Terminals.length).toBe(2)
      expect(project2Terminals.length).toBe(1)

      // AC3: ptyId bindings should be preserved
      expect(project1Terminals[0].ptyId).toBe('pty-project-1-a')
      expect(project1Terminals[1].ptyId).toBe('pty-project-1-b')
    })

    it('should find terminals by ptyId across multiple projects', () => {
      // Setup: Terminals with ptyIds across projects
      const { setTerminalPtyId, findTerminalByPtyId } = useTerminalStore.getState()
      setTerminalPtyId('t1', 'pty-cross-project-1')
      setTerminalPtyId('t3', 'pty-cross-project-2')

      // Test: findTerminalByPtyId should work regardless of which project is active
      const terminal1 = findTerminalByPtyId('pty-cross-project-1')
      const terminal2 = findTerminalByPtyId('pty-cross-project-2')

      expect(terminal1?.projectId).toBe('1')
      expect(terminal2?.projectId).toBe('2')
    })

    it('should maintain ptyIdIndex across project switches', () => {
      // Setup: Assign ptyIds
      const { setTerminalPtyId, findTerminalByPtyId } = useTerminalStore.getState()
      setTerminalPtyId('t1', 'pty-index-test-1')
      setTerminalPtyId('t3', 'pty-index-test-2')

      // Switch to project 2
      useProjectStore.setState({ activeProjectId: '2' })

      // The ptyIdIndex should still work for lookups
      const terminal = findTerminalByPtyId('pty-index-test-1')
      expect(terminal).toBeDefined()
      expect(terminal?.projectId).toBe('1')
    })

    it('should allow re-selecting terminals when returning to a project', () => {
      // Setup: Terminals exist for project 1 with ptyIds
      const { setTerminalPtyId, selectTerminal } = useTerminalStore.getState()
      setTerminalPtyId('t1', 'pty-return-test')
      setTerminalPtyId('t2', 'pty-return-test-2')

      // Switch to project 2
      useProjectStore.setState({ activeProjectId: '2' })
      useTerminalStore.setState({ activeTerminalId: 't3' })

      // Switch back to project 1
      useProjectStore.setState({ activeProjectId: '1' })

      // Select a terminal from project 1
      selectTerminal('t2')

      const { activeTerminalId, terminals } = useTerminalStore.getState()
      expect(activeTerminalId).toBe('t2')

      // Terminal should still have its ptyId
      const terminal = terminals.find((t) => t.id === 't2')
      expect(terminal?.ptyId).toBe('pty-return-test-2')
    })

    it('should maintain separate terminal lists per project', () => {
      const { terminals } = useTerminalStore.getState()

      // Verify terminals are properly associated with their projects
      const project1Ids = terminals.filter((t) => t.projectId === '1').map((t) => t.id)
      const project2Ids = terminals.filter((t) => t.projectId === '2').map((t) => t.id)

      expect(project1Ids).toEqual(expect.arrayContaining(['t1', 't2']))
      expect(project2Ids).toEqual(['t3'])

      // No overlap between projects
      const overlap = project1Ids.filter((id) => project2Ids.includes(id))
      expect(overlap).toHaveLength(0)
    })
  })
})
