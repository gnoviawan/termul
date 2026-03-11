import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CommandHistoryModal } from './CommandHistoryModal'
import { CommandHistoryEntry } from '@/stores/command-history-store'

describe('CommandHistoryModal', () => {
  const mockEntries: CommandHistoryEntry[] = [
    {
      id: '1',
      command: 'npm install',
      terminalName: 'default',
      terminalId: 'term-1',
      projectId: 'proj-1',
      timestamp: Date.now() - 60000
    },
    {
      id: '2',
      command: 'npm run dev',
      terminalName: 'default',
      terminalId: 'term-1',
      projectId: 'proj-1',
      timestamp: Date.now() - 120000
    },
    {
      id: '3',
      command: 'git status',
      terminalName: 'default',
      terminalId: 'term-1',
      projectId: 'proj-1',
      timestamp: Date.now() - 180000
    }
  ]

  const mockAllEntries: CommandHistoryEntry[] = [
    ...mockEntries,
    {
      id: '4',
      command: 'cargo build',
      terminalName: 'rust',
      terminalId: 'term-2',
      projectId: 'proj-2',
      timestamp: Date.now() - 30000
    }
  ]

  const defaultProps = {
    isOpen: true,
    entries: mockEntries,
    allEntries: mockAllEntries,
    onClose: vi.fn(),
    onSelectCommand: vi.fn(),
    onClearHistory: vi.fn().mockResolvedValue(undefined)
  }

  it('should render title when open', () => {
    render(<CommandHistoryModal {...defaultProps} />)

    expect(screen.getByText('Command History')).toBeInTheDocument()
  })

  it('should not render when closed', () => {
    render(<CommandHistoryModal {...defaultProps} isOpen={false} />)

    expect(screen.queryByText('Command History')).not.toBeInTheDocument()
  })

  it('should render command entries', async () => {
    render(<CommandHistoryModal {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('npm install')).toBeInTheDocument()
      expect(screen.getByText('npm run dev')).toBeInTheDocument()
      expect(screen.getByText('git status')).toBeInTheDocument()
    })
  })

  it('should render terminal name and time for each entry', async () => {
    render(<CommandHistoryModal {...defaultProps} />)

    await waitFor(() => {
      const terminalNames = screen.getAllByText('default')
      expect(terminalNames).toHaveLength(3)
    })
  })

  it('should filter entries based on search query', async () => {
    render(<CommandHistoryModal {...defaultProps} />)

    const input = screen.getByPlaceholderText('Search commands...')
    fireEvent.change(input, { target: { value: 'npm' } })

    await waitFor(() => {
      expect(screen.getByText('npm install')).toBeInTheDocument()
      expect(screen.getByText('npm run dev')).toBeInTheDocument()
      expect(screen.queryByText('git status')).not.toBeInTheDocument()
    })
  })

  it('should show empty state when no entries', () => {
    render(<CommandHistoryModal {...defaultProps} entries={[]} allEntries={[]} />)

    expect(screen.getByText('No command history yet')).toBeInTheDocument()
  })

  it('should show empty state when no matching results', () => {
    render(<CommandHistoryModal {...defaultProps} />)

    const input = screen.getByPlaceholderText('Search commands...')
    fireEvent.change(input, { target: { value: 'nonexistent' } })

    expect(screen.getByText('No matching commands')).toBeInTheDocument()
  })

  it('should call onClose on escape key', () => {
    const onClose = vi.fn()
    render(<CommandHistoryModal {...defaultProps} onClose={onClose} />)

    const input = screen.getByPlaceholderText('Search commands...')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('should call onSelectCommand and onClose when clicking an entry', async () => {
    const onSelectCommand = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandHistoryModal
        {...defaultProps}
        onSelectCommand={onSelectCommand}
        onClose={onClose}
      />
    )

    await waitFor(() => {
      const entry = screen.getByText('npm install')
      fireEvent.click(entry)
    })

    expect(onSelectCommand).toHaveBeenCalledWith('npm install')
    expect(onClose).toHaveBeenCalled()
  })

  it('should select command and close on Enter key', () => {
    const onSelectCommand = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandHistoryModal
        {...defaultProps}
        onSelectCommand={onSelectCommand}
        onClose={onClose}
      />
    )

    const input = screen.getByPlaceholderText('Search commands...')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelectCommand).toHaveBeenCalledWith('npm install')
    expect(onClose).toHaveBeenCalled()
  })

  it('should navigate entries with arrow keys', () => {
    render(<CommandHistoryModal {...defaultProps} />)

    const input = screen.getByPlaceholderText('Search commands...')

    // Arrow down should increment selection
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    // Arrow up should decrement selection
    fireEvent.keyDown(input, { key: 'ArrowUp' })
  })

  it('should call onClose when clicking backdrop', () => {
    const onClose = vi.fn()
    const { container } = render(<CommandHistoryModal {...defaultProps} onClose={onClose} />)

    const backdrop = container.querySelector('.fixed.inset-0')
    if (backdrop) {
      fireEvent.click(backdrop)
    }

    expect(onClose).toHaveBeenCalled()
  })

  it('should prevent click propagation when clicking modal content', () => {
    const onClose = vi.fn()
    render(<CommandHistoryModal {...defaultProps} onClose={onClose} />)

    const modalContent = screen.getByText('Command History').closest('.bg-card')
    if (modalContent) {
      fireEvent.click(modalContent)
    }

    expect(onClose).not.toHaveBeenCalled()
  })

  it('should display keyboard shortcuts in footer', () => {
    render(<CommandHistoryModal {...defaultProps} />)

    expect(screen.getByText(/to navigate/)).toBeInTheDocument()
    expect(screen.getByText(/to insert/)).toBeInTheDocument()
    expect(screen.getByText(/to close/)).toBeInTheDocument()
  })

  // Project filter tests
  describe('Project Filter', () => {
    it('should render filter dropdown showing "This Project" by default', () => {
      render(<CommandHistoryModal {...defaultProps} />)

      expect(screen.getByText('This Project')).toBeInTheDocument()
    })

    it('should show only current project entries by default', async () => {
      render(<CommandHistoryModal {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText('npm install')).toBeInTheDocument()
        expect(screen.getByText('git status')).toBeInTheDocument()
        expect(screen.queryByText('cargo build')).not.toBeInTheDocument()
      })
    })

    it('should show entries from all projects when filter is changed to "All Projects"', async () => {
      render(<CommandHistoryModal {...defaultProps} />)

      // Click on the filter dropdown
      const trigger = screen.getByRole('combobox')
      fireEvent.click(trigger)

      // Select "All Projects"
      const allProjectsOption = screen.getByRole('option', { name: 'All Projects' })
      fireEvent.click(allProjectsOption)

      await waitFor(() => {
        expect(screen.getByText('npm install')).toBeInTheDocument()
        expect(screen.getByText('cargo build')).toBeInTheDocument()
      })
    })

    it('should filter back to current project when switching back to "This Project"', async () => {
      render(<CommandHistoryModal {...defaultProps} />)

      // Switch to All Projects
      const trigger = screen.getByRole('combobox')
      fireEvent.click(trigger)
      const allProjectsOption = screen.getByRole('option', { name: 'All Projects' })
      fireEvent.click(allProjectsOption)

      await waitFor(() => {
        expect(screen.getByText('cargo build')).toBeInTheDocument()
      })

      // Switch back to This Project
      fireEvent.click(trigger)
      const thisProjectOption = screen.getByRole('option', { name: 'This Project' })
      fireEvent.click(thisProjectOption)

      await waitFor(() => {
        expect(screen.getByText('npm install')).toBeInTheDocument()
        expect(screen.queryByText('cargo build')).not.toBeInTheDocument()
      })
    })

    it('should maintain search query when changing project filter', async () => {
      render(<CommandHistoryModal {...defaultProps} />)

      // Type search query
      const input = screen.getByPlaceholderText('Search commands...')
      fireEvent.change(input, { target: { value: 'npm' } })

      await waitFor(() => {
        expect(screen.getByText('npm install')).toBeInTheDocument()
        expect(screen.queryByText('git status')).not.toBeInTheDocument()
      })

      // Switch to All Projects
      const trigger = screen.getByRole('combobox')
      fireEvent.click(trigger)
      const allProjectsOption = screen.getByRole('option', { name: 'All Projects' })
      fireEvent.click(allProjectsOption)

      // Search should still filter
      await waitFor(() => {
        expect(screen.getByText('npm install')).toBeInTheDocument()
        expect(screen.queryByText('cargo build')).not.toBeInTheDocument()
      })
    })
  })

  // Clear history tests
  describe('Clear History', () => {
    it('should render Clear History button in footer', () => {
      render(<CommandHistoryModal {...defaultProps} />)

      expect(screen.getByText('Clear History')).toBeInTheDocument()
    })

    it('should disable Clear History button when no entries', () => {
      render(<CommandHistoryModal {...defaultProps} entries={[]} allEntries={[]} />)

      const clearButton = screen.getByText('Clear History').closest('button')
      expect(clearButton).toBeDisabled()
    })

    it('should disable Clear History button when viewing All Projects', async () => {
      render(<CommandHistoryModal {...defaultProps} />)

      // Switch to All Projects
      const trigger = screen.getByRole('combobox')
      fireEvent.click(trigger)
      const allProjectsOption = screen.getByRole('option', { name: 'All Projects' })
      fireEvent.click(allProjectsOption)

      await waitFor(() => {
        const clearButton = screen.getByText('Clear History').closest('button')
        expect(clearButton).toBeDisabled()
      })
    })

    it('should show confirmation dialog when clicking Clear History', async () => {
      render(<CommandHistoryModal {...defaultProps} />)

      const clearButton = screen.getByText('Clear History')
      fireEvent.click(clearButton)

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
        expect(
          screen.getByText(/Are you sure you want to clear the command history/)
        ).toBeInTheDocument()
      })
    })

    it('should call onClearHistory when confirming clear', async () => {
      const onClearHistory = vi.fn().mockResolvedValue(undefined)
      render(<CommandHistoryModal {...defaultProps} onClearHistory={onClearHistory} />)

      const clearButton = screen.getByText('Clear History')
      fireEvent.click(clearButton)

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
      })

      const confirmButton = screen.getByRole('button', { name: 'Clear' })
      fireEvent.click(confirmButton)

      expect(onClearHistory).toHaveBeenCalledTimes(1)
    })

    it('should not call onClearHistory when canceling clear', async () => {
      const onClearHistory = vi.fn().mockResolvedValue(undefined)
      render(<CommandHistoryModal {...defaultProps} onClearHistory={onClearHistory} />)

      const clearButton = screen.getByText('Clear History')
      fireEvent.click(clearButton)

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
      })

      const cancelButton = screen.getByRole('button', { name: 'Cancel' })
      fireEvent.click(cancelButton)

      expect(onClearHistory).not.toHaveBeenCalled()
    })

    it('should close confirmation dialog after clearing', async () => {
      const onClearHistory = vi.fn().mockResolvedValue(undefined)
      render(<CommandHistoryModal {...defaultProps} onClearHistory={onClearHistory} />)

      const clearButton = screen.getByText('Clear History')
      fireEvent.click(clearButton)

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
      })

      const confirmButton = screen.getByRole('button', { name: 'Clear' })
      fireEvent.click(confirmButton)

      await waitFor(() => {
        expect(screen.queryByText('Clear Command History')).not.toBeInTheDocument()
      })
    })
  })
})