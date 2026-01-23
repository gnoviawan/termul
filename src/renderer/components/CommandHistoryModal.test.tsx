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
      timestamp: Date.now() - 60000
    },
    {
      id: '2',
      command: 'npm run dev',
      terminalName: 'default',
      timestamp: Date.now() - 120000
    },
    {
      id: '3',
      command: 'git status',
      terminalName: 'default',
      timestamp: Date.now() - 180000
    }
  ]

  const defaultProps = {
    isOpen: true,
    entries: mockEntries,
    onClose: vi.fn(),
    onSelectCommand: vi.fn()
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
    render(<CommandHistoryModal {...defaultProps} entries={[]} />)

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
    render(<CommandHistoryModal {...defaultProps} onSelectCommand={onSelectCommand} onClose={onClose} />)

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
    render(<CommandHistoryModal {...defaultProps} onSelectCommand={onSelectCommand} onClose={onClose} />)

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
})
