import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ActivityIndicator } from './ActivityIndicator'

describe('ActivityIndicator', () => {
  beforeEach(() => {
    // Mock matchMedia for prefers-reduced-motion
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('should render without errors', () => {
    render(<ActivityIndicator />)

    const indicator = screen.getByLabelText('Terminal has activity')
    expect(indicator).toBeInTheDocument()
  })

  it('should render with base classes', () => {
    render(<ActivityIndicator />)

    const indicator = screen.getByLabelText('Terminal has activity')
    expect(indicator).toHaveClass('h-2', 'w-2', 'rounded-full', 'bg-primary')
  })

  it('should accept and apply custom className prop', () => {
    render(<ActivityIndicator className="custom-class" />)

    const indicator = screen.getByLabelText('Terminal has activity')
    expect(indicator).toHaveClass('custom-class')
  })

  it('should have proper accessibility attributes', () => {
    render(<ActivityIndicator />)

    const indicator = screen.getByLabelText('Terminal has activity')
    expect(indicator).toHaveAttribute('aria-label', 'Terminal has activity')
    expect(indicator).toHaveAttribute('role', 'status')
  })

  it('should render as a div element', () => {
    render(<ActivityIndicator />)

    const indicator = screen.getByLabelText('Terminal has activity')
    expect(indicator.tagName).toBe('DIV')
  })
})
