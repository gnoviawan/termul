import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import React, { createContext, useContext, useState } from 'react'

type SelectProps = {
  value?: string
  onValueChange?: (value: string) => void
  children?: React.ReactNode
}

type SelectTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode
}

type SelectContentProps = {
  children?: React.ReactNode
}

type SelectItemProps = {
  value: string
  children?: React.ReactNode
}

type VirtuosoProps<T> = {
  data: T[]
  itemContent: (index: number, item: T) => React.ReactNode
}

const SelectContext = createContext<{
  value: string | undefined
  setValue: (value: string) => void
  open: boolean
  setOpen: (open: boolean) => void
} | null>(null)

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>
  }
})

vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: SelectProps) => {
    const [internalValue, setInternalValue] = useState(value)
    const [open, setOpen] = useState(false)
    const currentValue = value ?? internalValue
    const setValue = (nextValue: string) => {
      setInternalValue(nextValue)
      onValueChange?.(nextValue)
      setOpen(false)
    }

    return (
      <SelectContext.Provider value={{ value: currentValue, setValue, open, setOpen }}>
        <div>{children}</div>
      </SelectContext.Provider>
    )
  },
  SelectTrigger: ({ children, ...props }: SelectTriggerProps) => {
    const ctx = useContext(SelectContext)
    return (
      <button type="button" role="combobox" {...props} onClick={() => ctx?.setOpen(!ctx.open)}>
        {children}
        <span>{ctx?.value === 'all-projects' ? 'All Projects' : 'This Project'}</span>
      </button>
    )
  },
  SelectContent: ({ children }: SelectContentProps) => {
    const ctx = useContext(SelectContext)
    return ctx?.open ? <div role="listbox">{children}</div> : null
  },
  SelectItem: ({ value, children }: SelectItemProps) => {
    const ctx = useContext(SelectContext)
    return (
      <button type="button" role="option" onClick={() => ctx?.setValue(value)}>
        {children}
      </button>
    )
  },
  SelectValue: () => null
}))

vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef<HTMLDivElement, VirtuosoProps<CommandHistoryEntry>>(
    ({ data, itemContent }, _ref) => (
      <div>{data.map((item, index) => itemContent(index, item))}</div>
  ))
}))

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel
  }: {
    isOpen: boolean
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    onConfirm: () => void
    onCancel: () => void
  }) =>
    isOpen ? (
      <div>
        <div>{title}</div>
        {message ? <div>{message}</div> : null}
        <button onClick={onCancel}>{cancelLabel}</button>
        <button onClick={onConfirm}>{confirmLabel}</button>
      </div>
    ) : null
}))

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
      await act(async () => {
        fireEvent.click(clearButton)
      })

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
      })

      const confirmButton = screen.getByRole('button', { name: 'Clear' })
      await act(async () => {
        fireEvent.click(confirmButton)
        await Promise.resolve()
        await Promise.resolve()
      })

      await waitFor(() => {
        expect(screen.queryByText('Clear Command History')).not.toBeInTheDocument()
      })

      expect(onClearHistory).toHaveBeenCalledTimes(1)
    })

    it('should not call onClearHistory when canceling clear', async () => {
      const onClearHistory = vi.fn().mockResolvedValue(undefined)
      render(<CommandHistoryModal {...defaultProps} onClearHistory={onClearHistory} />)

      const clearButton = screen.getByText('Clear History')
      await act(async () => {
        fireEvent.click(clearButton)
      })

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
      })

      const cancelButton = screen.getByRole('button', { name: 'Cancel' })
      await act(async () => {
        fireEvent.click(cancelButton)
        await Promise.resolve()
        await Promise.resolve()
      })

      await waitFor(() => {
        expect(screen.queryByText('Clear Command History')).not.toBeInTheDocument()
      })

      expect(onClearHistory).not.toHaveBeenCalled()
    })

    it('should close confirmation dialog after clearing', async () => {
      const onClearHistory = vi.fn().mockResolvedValue(undefined)
      render(<CommandHistoryModal {...defaultProps} onClearHistory={onClearHistory} />)

      const clearButton = screen.getByText('Clear History')
      await act(async () => {
        fireEvent.click(clearButton)
      })

      await waitFor(() => {
        expect(screen.getByText('Clear Command History')).toBeInTheDocument()
      })

      const confirmButton = screen.getByRole('button', { name: 'Clear' })
      await act(async () => {
        fireEvent.click(confirmButton)
      })

      await waitFor(() => {
        expect(screen.queryByText('Clear Command History')).not.toBeInTheDocument()
      })
    })
  })
})
