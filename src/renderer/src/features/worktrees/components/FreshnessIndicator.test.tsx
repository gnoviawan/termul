/**
 * Unit tests for FreshnessIndicator Component
 *
 * Tests relative time calculation, freshness levels, and visual variants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FreshnessIndicator } from './FreshnessIndicator'


describe('FreshnessIndicator', () => {
  // Mock current date to 2026-01-16 12:00:00
  const mockNow = new Date('2026-01-16T12:00:00.000Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(mockNow)
  })

  afterEach(() => {
    vi.useRealTimers()
  })


  describe('time calculation', () => {
    it('should show "Just now" for less than 1 minute', () => {
      const lastAccessed = new Date('2026-01-16T11:59:30.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('Just now')).toBeInTheDocument()
    })

    it('should show minutes ago for recent access', () => {
      const lastAccessed = new Date('2026-01-16T11:45:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('15m ago')).toBeInTheDocument()
    })

    it('should show hours ago for same-day access', () => {
      const lastAccessed = new Date('2026-01-16T08:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('4h ago')).toBeInTheDocument()
    })

    it('should show "Today" for today', () => {
      const lastAccessed = new Date('2026-01-16T01:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('Today')).toBeInTheDocument()
    })

    it('should show "Yesterday" for yesterday', () => {
      const lastAccessed = new Date('2026-01-15T12:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('Yesterday')).toBeInTheDocument()
    })

    it('should show days ago for recent days', () => {
      const lastAccessed = new Date('2026-01-13T12:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('3d ago')).toBeInTheDocument()
    })

    it('should show weeks ago for older access', () => {
      const lastAccessed = new Date('2026-01-02T12:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('2w ago')).toBeInTheDocument()
    })

    it('should show months ago for very old access', () => {
      const lastAccessed = new Date('2025-12-01T12:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('1mo ago')).toBeInTheDocument()
    })
  })

  describe('freshness levels', () => {
    it('should show recent style for < 3 days', () => {
      const lastAccessed = new Date('2026-01-14T12:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} variant="badge" />
      )

      const badge = container.querySelector('.bg-green-500\\/10')
      expect(badge).toBeInTheDocument()
    })

    it('should show stale style for 3-13 days', () => {
      const lastAccessed = new Date('2026-01-05T12:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} variant="badge" />
      )

      const badge = container.querySelector('.bg-yellow-500\\/10')
      expect(badge).toBeInTheDocument()
    })

    it('should show very-stale style for 14+ days', () => {
      const lastAccessed = new Date('2025-12-20T12:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} variant="badge" />
      )

      const badge = container.querySelector('.bg-red-500\\/10')
      expect(badge).toBeInTheDocument()
    })

    it('should show alert icon for very stale worktrees', () => {
      const lastAccessed = new Date('2025-12-20T12:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} />
      )

      const alertIcon = container.querySelector('svg')
      expect(alertIcon).toBeInTheDocument()
    })
  })

  describe('variants', () => {
    it('should render text variant by default', () => {
      const lastAccessed = new Date('2026-01-16T08:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      expect(screen.getByText('4h ago')).toBeInTheDocument()
    })

    it('should render badge variant with styled background', () => {
      const lastAccessed = new Date('2026-01-16T08:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} variant="badge" />
      )

      const badge = container.querySelector('.inline-flex')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveClass('px-2', 'py-0.5', 'rounded')

    })

    it('should render minimal variant without icon', () => {
      const lastAccessed = new Date('2026-01-16T08:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} variant="minimal" />
      )

      const icon = container.querySelector('svg')
      expect(icon).not.toBeInTheDocument()
    })

    it('should hide icon when showIcon is false', () => {
      const lastAccessed = new Date('2026-01-16T08:00:00.000Z').toISOString()

      const { container } = render(
        <FreshnessIndicator lastAccessedAt={lastAccessed} showIcon={false} />
      )

      const icon = container.querySelector('svg')
      expect(icon).not.toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('should have tooltip with full description', () => {
      const lastAccessed = new Date('2026-01-15T12:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      const indicator = screen.getByText('Yesterday')
      expect(indicator).toHaveAttribute('title', expect.stringContaining('Last worked:'))
    })

    it('should have screen reader text with full description', () => {
      const lastAccessed = new Date('2026-01-15T12:00:00.000Z').toISOString()

      render(<FreshnessIndicator lastAccessedAt={lastAccessed} />)

      const srText = screen.getByText(/Last worked:/)
      expect(srText).toHaveClass('sr-only')
    })
  })
})
