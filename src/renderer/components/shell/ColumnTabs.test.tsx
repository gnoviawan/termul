import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ColumnTabs } from './ColumnTabs'
import { visibleColumnTab } from './column-tab'

describe('ColumnTabs', () => {
  it('renders Explorer, Changes, GitHub in order as a tablist (no Chats tab)', () => {
    render(<ColumnTabs selected="explorer" onSelect={vi.fn()} changedCount={0} />)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(
      screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label') ?? t.textContent)
    ).toEqual(['Explorer', 'Changes', 'GitHub'])
  })

  it('shows GitHub as an icon whose label is its name and tooltip', () => {
    const onSelect = vi.fn()
    render(<ColumnTabs selected="explorer" onSelect={onSelect} changedCount={0} />)
    const github = screen.getByRole('tab', { name: 'GitHub' })
    expect(github).toHaveAttribute('title', 'GitHub')
    expect(github).toHaveTextContent('')
    fireEvent.click(github)
    expect(onSelect).toHaveBeenCalledWith('github')
  })

  it('marks the selected tab and roves the tabindex', () => {
    render(<ColumnTabs selected="explorer" onSelect={vi.fn()} changedCount={0} />)
    const [explorer, changes, github] = screen.getAllByRole('tab')
    expect(explorer).toHaveAttribute('aria-selected', 'true')
    expect(changes).toHaveAttribute('aria-selected', 'false')
    expect(explorer).toHaveAttribute('tabindex', '0')
    expect(changes).toHaveAttribute('tabindex', '-1')
    expect(github).toHaveAttribute('tabindex', '-1')
  })

  it('selects a tab on click', () => {
    const onSelect = vi.fn()
    render(<ColumnTabs selected="explorer" onSelect={onSelect} changedCount={0} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    expect(onSelect).toHaveBeenCalledWith('changes')
  })

  it('moves and selects with Left and Right, wrapping at both ends', () => {
    const onSelect = vi.fn()
    render(<ColumnTabs selected="explorer" onSelect={onSelect} changedCount={0} />)
    const [explorer, changes, github] = screen.getAllByRole('tab')

    explorer.focus()
    fireEvent.keyDown(explorer, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('changes')
    expect(changes).toHaveFocus()

    fireEvent.keyDown(explorer, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('github')
    expect(github).toHaveFocus()

    fireEvent.keyDown(github, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('explorer')
  })

  it('shows the changed-file badge only above zero and caps it at 99+', () => {
    const { rerender } = render(
      <ColumnTabs selected="explorer" onSelect={vi.fn()} changedCount={0} />
    )
    expect(screen.queryByTestId('column-tab-changes-badge')).toBeNull()

    rerender(<ColumnTabs selected="explorer" onSelect={vi.fn()} changedCount={7} />)
    expect(screen.getByTestId('column-tab-changes-badge')).toHaveTextContent('7')
    expect(screen.getByRole('tab', { name: /Changes/ })).toContainElement(
      screen.getByTestId('column-tab-changes-badge')
    )

    rerender(<ColumnTabs selected="explorer" onSelect={vi.fn()} changedCount={150} />)
    expect(screen.getByTestId('column-tab-changes-badge')).toHaveTextContent('99+')
  })

  it('reads a stored Chats tab, or none, as Explorer', () => {
    expect(visibleColumnTab('chats')).toBe('explorer')
    expect(visibleColumnTab(undefined)).toBe('explorer')
    expect(visibleColumnTab('github')).toBe('github')
  })
})
