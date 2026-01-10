import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Confirm Action',
    message: 'Are you sure?',
    onConfirm: vi.fn(),
    onCancel: vi.fn()
  }

  it('should render title and message when open', () => {
    render(<ConfirmDialog {...defaultProps} />)

    expect(screen.getByText('Confirm Action')).toBeInTheDocument()
    expect(screen.getByText('Are you sure?')).toBeInTheDocument()
  })

  it('should not render when closed', () => {
    render(<ConfirmDialog {...defaultProps} isOpen={false} />)

    expect(screen.queryByText('Confirm Action')).not.toBeInTheDocument()
  })

  it('should call onConfirm when confirm button is clicked', () => {
    const onConfirm = vi.fn()
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByText('Confirm'))

    expect(onConfirm).toHaveBeenCalled()
  })

  it('should call onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByText('Cancel'))

    expect(onCancel).toHaveBeenCalled()
  })

  it('should call onCancel on escape key', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalled()
  })

  it('should use custom button labels', () => {
    render(
      <ConfirmDialog {...defaultProps} confirmLabel="Delete" cancelLabel="Keep" />
    )

    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.getByText('Keep')).toBeInTheDocument()
  })

  it('should apply danger styling for danger variant', () => {
    render(<ConfirmDialog {...defaultProps} variant="danger" confirmLabel="Delete" />)

    const deleteButton = screen.getByText('Delete')
    expect(deleteButton).toHaveClass('bg-red-500')
  })

  it('should call onCancel when clicking backdrop', () => {
    const onCancel = vi.fn()
    const { container } = render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />)

    const backdrop = container.querySelector('.fixed.inset-0')
    if (backdrop) {
      fireEvent.click(backdrop)
    }

    expect(onCancel).toHaveBeenCalled()
  })
})
