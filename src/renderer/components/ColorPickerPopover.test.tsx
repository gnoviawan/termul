import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ColorPickerPopover } from './ColorPickerPopover'
import type { ProjectColor } from '@/types/project'

describe('ColorPickerPopover', () => {
  const defaultProps = {
    x: 100,
    y: 100,
    currentColor: 'blue' as ProjectColor,
    onSelectColor: vi.fn(),
    onClose: vi.fn()
  }

  it('should render color options', () => {
    render(<ColorPickerPopover {...defaultProps} />)

    expect(screen.getByText('Select Color')).toBeInTheDocument()
    // Should render multiple color buttons
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
  })

  it('should call onSelectColor and onClose when color is selected', () => {
    const onSelectColor = vi.fn()
    const onClose = vi.fn()
    render(
      <ColorPickerPopover
        {...defaultProps}
        onSelectColor={onSelectColor}
        onClose={onClose}
      />
    )

    // Click the first color button
    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[0])

    expect(onSelectColor).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('should close on escape key', () => {
    const onClose = vi.fn()
    render(<ColorPickerPopover {...defaultProps} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('should highlight current color', () => {
    render(<ColorPickerPopover {...defaultProps} currentColor="blue" />)

    // The current color button should have ring styling
    const buttons = screen.getAllByRole('button')
    const hasRingButton = buttons.some((btn) => btn.className.includes('ring-2'))
    expect(hasRingButton).toBe(true)
  })
})
