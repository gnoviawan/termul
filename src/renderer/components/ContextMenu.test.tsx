import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextMenu } from './ContextMenu'

describe('ContextMenu', () => {
  const defaultItems = [
    { label: 'Rename', onClick: vi.fn() },
    { label: 'Delete', onClick: vi.fn(), variant: 'danger' as const }
  ]

  it('should render menu items', () => {
    render(<ContextMenu items={defaultItems} x={100} y={100} onClose={vi.fn()} />)

    expect(screen.getByText('Rename')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('should call onClick when item is clicked', () => {
    const onClose = vi.fn()
    const onRename = vi.fn()
    const items = [{ label: 'Rename', onClick: onRename }]

    render(<ContextMenu items={items} x={100} y={100} onClose={onClose} />)

    fireEvent.click(screen.getByText('Rename'))

    expect(onRename).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('should close on escape key', () => {
    const onClose = vi.fn()
    render(<ContextMenu items={defaultItems} x={100} y={100} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('should not call onClick for disabled items', () => {
    const onClose = vi.fn()
    const onClick = vi.fn()
    const items = [{ label: 'Disabled Item', onClick, disabled: true }]

    render(<ContextMenu items={items} x={100} y={100} onClose={onClose} />)

    fireEvent.click(screen.getByText('Disabled Item'))

    expect(onClick).not.toHaveBeenCalled()
  })

  it('should render icons when provided', () => {
    const items = [{ label: 'With Icon', onClick: vi.fn(), icon: <span data-testid="icon">X</span> }]

    render(<ContextMenu items={items} x={100} y={100} onClose={vi.fn()} />)

    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('should position menu at specified coordinates', () => {
    render(<ContextMenu items={defaultItems} x={150} y={200} onClose={vi.fn()} />)

    const menu = screen.getByText('Rename').closest('.fixed')
    expect(menu).toHaveStyle({ left: '150px', top: '200px' })
  })

  it('should apply danger styling to danger variant items', () => {
    render(<ContextMenu items={defaultItems} x={100} y={100} onClose={vi.fn()} />)

    const deleteButton = screen.getByText('Delete')
    expect(deleteButton).toHaveClass('text-red-400')
  })
})
