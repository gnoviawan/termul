import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

// Mock window.api before any imports that use it
Object.defineProperty(window, 'api', {
  value: {
    persistence: {
      read: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
      write: vi.fn(() => Promise.resolve({ success: true }))
    }
  } as unknown as Window['api'],
  writable: true
})

const mockSelectProject = vi.fn()
const mockAddProject = vi.fn()
const mockSelectTerminal = vi.fn()
const mockAddTerminal = vi.fn()
const mockCloseTerminal = vi.fn()
const mockRenameTerminal = vi.fn()

const mockProjects = [
  { id: '1', name: 'Test Project', color: 'blue' as const, path: '/test/path' }
]

const mockTerminals = [
  { id: 't1', name: 'Terminal 1', projectId: '1', shell: 'bash', output: [] }
]

let projectsData = { projects: mockProjects, activeProject: mockProjects[0], activeProjectId: '1' }
let terminalsData = { terminals: mockTerminals, activeTerminal: mockTerminals[0] }

// Mock project store
vi.mock('@/stores/project-store', () => ({
  useProjectsLoaded: () => true,
  useProjects: () => projectsData.projects,
  useActiveProject: () => projectsData.activeProject,
  useActiveProjectId: () => projectsData.activeProjectId,
  useProjectStore: (selector: (state: { activeProjectId: string }) => string) =>
    selector({ activeProjectId: projectsData.activeProjectId }),
  useProjectActions: () => ({
    selectProject: mockSelectProject,
    addProject: mockAddProject,
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    reorderProjects: vi.fn()
  })
}))

// Mock terminal store
vi.mock('@/stores/terminal-store', () => ({
  useAllTerminals: () => terminalsData.terminals,
  useTerminals: () => terminalsData.terminals,
  useActiveTerminal: () => terminalsData.activeTerminal,
  useActiveTerminalId: () => terminalsData.activeTerminal?.id || '',
  useTerminalStore: (selector: (state: { terminals: typeof mockTerminals; activeTerminalId: string }) => unknown) =>
    selector({ terminals: terminalsData.terminals, activeTerminalId: terminalsData.activeTerminal?.id || '' }),
  useTerminalActions: () => ({
    selectTerminal: mockSelectTerminal,
    addTerminal: mockAddTerminal,
    closeTerminal: mockCloseTerminal,
    renameTerminal: mockRenameTerminal,
    reorderTerminals: vi.fn(),
    setTerminalPtyId: vi.fn()
  })
}))

// Mock ConnectedTerminal to avoid xterm.js complexities
vi.mock('@/components/terminal/ConnectedTerminal', () => ({
  ConnectedTerminal: ({ className }: { className?: string }) => (
    <div data-testid="connected-terminal" className={className}>
      Mock Terminal
    </div>
  )
}))

// Mock child components that don't need full testing here
vi.mock('@/components/ProjectSidebar', () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar">Sidebar</div>
}))

vi.mock('@/components/TerminalTabBar', () => ({
  TerminalTabBar: ({
    onNewTerminal,
    onSelectTerminal,
    onCloseTerminal,
    onRenameTerminal,
    terminals,
    activeTerminalId
  }: {
    onNewTerminal: () => void
    onSelectTerminal: (id: string) => void
    onCloseTerminal: (id: string) => void
    onRenameTerminal: (id: string, name: string) => void
    terminals: Array<{ id: string; name: string }>
    activeTerminalId: string
  }) => (
    <div data-testid="terminal-tab-bar">
      <button onClick={onNewTerminal} data-testid="new-terminal-btn">
        New Terminal
      </button>
      {terminals.map((t) => (
        <div key={t.id}>
          <button
            onClick={() => onSelectTerminal(t.id)}
            data-testid={`terminal-tab-${t.id}`}
            data-active={t.id === activeTerminalId}
          >
            {t.name}
          </button>
          <button
            onClick={() => onCloseTerminal(t.id)}
            data-testid={`close-terminal-${t.id}`}
          >
            Close
          </button>
          <button
            onClick={() => onRenameTerminal(t.id, 'New Name')}
            data-testid={`rename-terminal-${t.id}`}
          >
            Rename
          </button>
        </div>
      ))}
    </div>
  )
}))

vi.mock('@/components/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar">Status</div>
}))

vi.mock('@/components/NewProjectModal', () => ({
  NewProjectModal: () => null
}))

vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: () => null
}))

// Mock app settings store
const mockAppSettings = {
  terminalFontFamily: 'Consolas',
  terminalFontSize: 14,
  defaultShell: '',
  terminalBufferSize: 5000,
  defaultProjectColor: 'blue',
  maxTerminalsPerProject: 10
}

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontSize: () => 14,
  useDefaultShell: () => '',
  useMaxTerminalsPerProject: () => 10,
  useUpdateAppSetting: () => vi.fn(),
  useAppSettingsStore: Object.assign(
    (selector: (state: { settings: typeof mockAppSettings }) => unknown) =>
      selector({ settings: mockAppSettings }),
    {
      getState: () => ({ settings: mockAppSettings, updateSetting: vi.fn() })
    }
  )
}))

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    onConfirm,
    onCancel
  }: {
    isOpen: boolean
    title: string
    message: string
    onConfirm: () => void
    onCancel: () => void
  }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <button onClick={onCancel} data-testid="confirm-dialog-cancel">
          Cancel
        </button>
        <button onClick={onConfirm} data-testid="confirm-dialog-confirm">
          Confirm
        </button>
      </div>
    ) : null
}))

import WorkspaceDashboard from './WorkspaceDashboard'

describe('WorkspaceDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectsData = { projects: mockProjects, activeProject: mockProjects[0], activeProjectId: '1' }
    terminalsData = { terminals: mockTerminals, activeTerminal: mockTerminals[0] }
  })

  afterEach(() => {
    cleanup()
  })

  it('should render full-width terminal when active terminal exists', () => {
    const { container } = render(<WorkspaceDashboard />)

    const terminal = screen.getByTestId('connected-terminal')
    expect(terminal).toBeTruthy()
    expect(terminal.className).toContain('w-full')
    expect(terminal.className).toContain('h-full')
  })

  it('should render empty state when no terminals exist', () => {
    terminalsData = { terminals: [], activeTerminal: undefined as never }

    render(<WorkspaceDashboard />)

    expect(screen.getByText('No terminal open. Create one to get started.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /create terminal/i })).toBeTruthy()
  })

  it('should call addTerminal when Create Terminal button clicked', () => {
    terminalsData = { terminals: [], activeTerminal: undefined as never }

    render(<WorkspaceDashboard />)

    const createBtn = screen.getByRole('button', { name: /create terminal/i })
    fireEvent.click(createBtn)

    expect(mockAddTerminal).toHaveBeenCalledWith('Terminal 1', '1', '', '/test/path')
  })

  it('should call addTerminal when tab bar new terminal clicked', () => {
    render(<WorkspaceDashboard />)

    const newTerminalBtn = screen.getByTestId('new-terminal-btn')
    fireEvent.click(newTerminalBtn)

    expect(mockAddTerminal).toHaveBeenCalledWith('Terminal 2', '1', '', '/test/path')
  })

  it('should render all main layout components', () => {
    render(<WorkspaceDashboard />)

    expect(screen.getByTestId('project-sidebar')).toBeTruthy()
    expect(screen.getByTestId('terminal-tab-bar')).toBeTruthy()
    expect(screen.getByTestId('status-bar')).toBeTruthy()
  })

  it('should call selectTerminal when terminal tab is clicked', () => {
    const multipleTerminals = [
      { id: 't1', name: 'Terminal 1', projectId: '1', shell: 'bash', output: [] },
      { id: 't2', name: 'Terminal 2', projectId: '1', shell: 'bash', output: [] }
    ]
    terminalsData = { terminals: multipleTerminals, activeTerminal: multipleTerminals[0] }

    render(<WorkspaceDashboard />)

    const tab2 = screen.getByTestId('terminal-tab-t2')
    fireEvent.click(tab2)

    expect(mockSelectTerminal).toHaveBeenCalledWith('t2')
  })

  it('should handle Ctrl+T keyboard shortcut', () => {
    render(<WorkspaceDashboard />)

    fireEvent.keyDown(window, { key: 't', ctrlKey: true })

    expect(mockAddTerminal).toHaveBeenCalledWith('Terminal 2', '1', '', '/test/path')
  })

  it('should navigate to next terminal with Ctrl+Tab', () => {
    const multipleTerminals = [
      { id: 't1', name: 'Terminal 1', projectId: '1', shell: 'bash', output: [] },
      { id: 't2', name: 'Terminal 2', projectId: '1', shell: 'bash', output: [] }
    ]
    terminalsData = { terminals: multipleTerminals, activeTerminal: multipleTerminals[0] }

    render(<WorkspaceDashboard />)

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })

    expect(mockSelectTerminal).toHaveBeenCalledWith('t2')
  })

  it('should navigate to previous terminal with Ctrl+Shift+Tab', () => {
    const multipleTerminals = [
      { id: 't1', name: 'Terminal 1', projectId: '1', shell: 'bash', output: [] },
      { id: 't2', name: 'Terminal 2', projectId: '1', shell: 'bash', output: [] }
    ]
    terminalsData = { terminals: multipleTerminals, activeTerminal: multipleTerminals[1] }

    render(<WorkspaceDashboard />)

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })

    expect(mockSelectTerminal).toHaveBeenCalledWith('t1')
  })

  it('should wrap around when navigating terminals', () => {
    const multipleTerminals = [
      { id: 't1', name: 'Terminal 1', projectId: '1', shell: 'bash', output: [] },
      { id: 't2', name: 'Terminal 2', projectId: '1', shell: 'bash', output: [] }
    ]
    terminalsData = { terminals: multipleTerminals, activeTerminal: multipleTerminals[1] }

    render(<WorkspaceDashboard />)

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })

    expect(mockSelectTerminal).toHaveBeenCalledWith('t1')
  })

  it('should show confirmation dialog when close terminal clicked', () => {
    render(<WorkspaceDashboard />)

    const closeBtn = screen.getByTestId('close-terminal-t1')
    fireEvent.click(closeBtn)

    expect(screen.getByTestId('confirm-dialog')).toBeTruthy()
    expect(screen.getByText('Close Terminal')).toBeTruthy()
  })

  it('should close terminal when confirmation is accepted', () => {
    render(<WorkspaceDashboard />)

    const closeBtn = screen.getByTestId('close-terminal-t1')
    fireEvent.click(closeBtn)

    const confirmBtn = screen.getByTestId('confirm-dialog-confirm')
    fireEvent.click(confirmBtn)

    expect(mockCloseTerminal).toHaveBeenCalledWith('t1', '1')
  })

  it('should not close terminal when confirmation is cancelled', () => {
    render(<WorkspaceDashboard />)

    const closeBtn = screen.getByTestId('close-terminal-t1')
    fireEvent.click(closeBtn)

    const cancelBtn = screen.getByTestId('confirm-dialog-cancel')
    fireEvent.click(cancelBtn)

    expect(mockCloseTerminal).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('should call renameTerminal when rename is triggered', () => {
    render(<WorkspaceDashboard />)

    const renameBtn = screen.getByTestId('rename-terminal-t1')
    fireEvent.click(renameBtn)

    expect(mockRenameTerminal).toHaveBeenCalledWith('t1', 'New Name')
  })

  describe('no projects empty state', () => {
    it('should render "Create Project" empty state when no projects exist', () => {
      projectsData = { projects: [], activeProject: undefined as never, activeProjectId: '' }

      render(<WorkspaceDashboard />)

      expect(screen.getByText('No projects yet. Create one to get started.')).toBeTruthy()
      expect(screen.getByRole('button', { name: /create project/i })).toBeTruthy()
    })

    it('should not render terminal tab bar when no projects exist', () => {
      projectsData = { projects: [], activeProject: undefined as never, activeProjectId: '' }

      render(<WorkspaceDashboard />)

      expect(screen.queryByTestId('terminal-tab-bar')).toBeNull()
    })
  })
})
