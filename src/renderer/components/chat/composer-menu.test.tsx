/**
 * Story 5.3 — ComposerMenu touch interaction tests (AC2, AC4).
 *
 * Covers:
 * - `onTouchEnd` selects the item reliably on touch (independent of mouse
 *   synthesis).
 * - Touch+mouse synthesis double-fire guard: a single tap selects exactly
 *   once even when both `touchend` and `mousedown` fire.
 * - Hit-target height ≥44px on narrow panes (asserted via computed class
 *   presence — jsdom doesn't apply `@container` CSS, so we verify the
 *   narrow-pane class is the default).
 * - `onMouseDown` still calls `preventDefault` (textarea doesn't blur).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerMenuItem, ComposerMenuSection } from './composer-menu'
import { ComposerMenu, type ComposerMenuHandle } from './composer-menu'

function makeItem(id: string, label: string): ComposerMenuItem {
  return { key: id, label, payload: id }
}

function makeSection(id: string, heading: string, items: ComposerMenuItem[]): ComposerMenuSection {
  return { id, heading, items }
}

describe('ComposerMenu touch interactions (Story 5.3)', () => {
  let originalInnerWidth: number

  beforeEach(() => {
    originalInnerWidth = window.innerWidth
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
    vi.restoreAllMocks()
  })

  it('calls onSelect exactly once when an option is tapped (touchend)', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    render(<ComposerMenu sections={sections} onSelect={onSelect} />)
    const option = screen.getByRole('option', { name: 'Alpha' })
    fireEvent.touchEnd(option)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('s1', expect.objectContaining({ key: 'a' }))
  })

  it('does not double-select when touch synthesis fires click after touchend', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    render(<ComposerMenu sections={sections} onSelect={onSelect} />)
    const option = screen.getByRole('option', { name: 'Alpha' })
    // Touch selects on touchend. A synthesized click must not select again.
    fireEvent.touchEnd(option)
    fireEvent.mouseDown(option)
    fireEvent.click(option)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('selects on click and does not select on mousedown', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    render(<ComposerMenu sections={sections} onSelect={onSelect} />)
    const option = screen.getByRole('option', { name: 'Alpha' })
    fireEvent.mouseDown(option)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(option)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('calls preventDefault on mousedown so the textarea does not blur', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    render(<ComposerMenu sections={sections} onSelect={onSelect} />)
    const option = screen.getByRole('option', { name: 'Alpha' })
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    const spy = vi.spyOn(event, 'preventDefault')
    fireEvent(option, event)
    expect(spy).toHaveBeenCalled()
  })

  it('renders narrow-pane hit-target classes by default (py-2.5) for ≥44px touch target', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    render(<ComposerMenu sections={sections} onSelect={onSelect} />)
    const option = screen.getByRole('option', { name: 'Alpha' })
    // jsdom doesn't apply `@container` CSS, so the narrow-pane classes
    // are present by default and the wide-pane variants stay in the class string.
    expect(option.className).toContain('min-h-11')
    expect(option.className).toContain('py-2.5')
    expect(option.className).toContain('@[400px]:min-h-8')
    expect(option.className).toContain('@[400px]:py-1.5')
  })

  it('keeps the 44px row on a coarse pointer in a wide pane, and 32px for a fine one', () => {
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    render(<ComposerMenu sections={sections} onSelect={vi.fn()} />)
    const classes = screen.getByRole('option', { name: 'Alpha' }).className.split(/\s+/)

    expect(classes).toEqual(
      expect.arrayContaining([
        '@[400px]:min-h-8',
        '@[400px]:py-1.5',
        'pointer-coarse:@[400px]:min-h-11',
        'pointer-coarse:@[400px]:py-2.5'
      ])
    )
  })

  it('highlights with a foreground wash and marks selection with a check, not a fill', () => {
    const sections = [
      makeSection('s1', 'Commands', [
        makeItem('a', 'Alpha'),
        { ...makeItem('b', 'Beta'), selected: true }
      ])
    ]
    const { container } = render(<ComposerMenu sections={sections} onSelect={vi.fn()} />)
    const shell = container.querySelector('[role="listbox"]')
    expect(shell?.className).toContain('rounded-xl')
    const alpha = screen.getByRole('option', { name: 'Alpha' })
    const beta = screen.getByRole('option', { name: 'Beta' })
    // The first row is the keyboard-highlighted row by default.
    expect(alpha.className).toContain('bg-foreground/[0.06]')
    expect(alpha.className).not.toContain('bg-secondary')
    expect(beta.className).not.toContain('bg-secondary')
    expect(beta.className).not.toMatch(/(^| )bg-foreground\/\[0\.06\]/)
    expect(beta.querySelector('svg')).not.toBeNull()
  })

  it('renders the narrow-pane max-h cap (max-h-[40vh]) for short mobile viewports', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    const { container } = render(<ComposerMenu sections={sections} onSelect={onSelect} />)
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    expect(listbox?.className).toContain('max-h-[40vh]')
    expect(listbox?.className).toContain('@[400px]:max-h-64')
  })

  it('preserves forwardRef selectHighlighted imperative API (keyboard path)', () => {
    const onSelect = vi.fn()
    const sections = [makeSection('s1', 'Commands', [makeItem('a', 'Alpha')])]
    let handle: ComposerMenuHandle | null = null
    render(
      <ComposerMenu
        ref={(h) => {
          handle = h
        }}
        sections={sections}
        onSelect={onSelect}
      />
    )
    const selected = handle?.selectHighlighted() ?? false
    expect(selected).toBe(true)
    expect(onSelect).toHaveBeenCalledOnce()
  })
})
