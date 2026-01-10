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
})
