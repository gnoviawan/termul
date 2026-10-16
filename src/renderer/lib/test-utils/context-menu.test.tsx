import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './context-menu'

afterEach(cleanup)

describe('context-menu test double', () => {
  it.each([
    ['wrapping', false],
    ['asChild', true]
  ])('keeps a disabled %s trigger closed and leaves the native menu alone', (_, asChild) => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild={asChild} disabled>
          <span>target</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    expect(fireEvent.contextMenu(screen.getByText('target'))).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the submenu of a disabled sub-trigger closed on hover and click', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span>target</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled>Move to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Workspace B</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('target'))
    const subTrigger = screen.getByText('Move to')
    fireEvent.mouseEnter(subTrigger)
    fireEvent.click(subTrigger)

    expect(screen.queryByText('Workspace B')).toBeNull()
    expect(subTrigger.getAttribute('aria-disabled')).toBe('true')
  })
})
