import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

/**
 * F5: locks the destructive-variant styling on `ContextMenuItem`
 * (ui/context-menu.tsx). Mirrors the deleted `ContextMenu.test.tsx`
 * `text-red-400` assertion — a destructive item must use the theme-token
 * `text-destructive` + `focus:bg-destructive/10`, never raw `red-*`.
 *
 * Radix's `MenuItem` must be used within a `Menu` context, so each test
 * renders the full `<ContextMenu>` tree, opens it via right-click, and
 * queries the portaled item via `findByRole('menuitem')`.
 */
describe('ContextMenuItem destructive variant (F5)', () => {
  function renderMenuTree(variant: 'default' | 'destructive' = 'default') {
    return render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button">trigger</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant={variant}>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  async function openAndGetItem(): Promise<HTMLElement> {
    fireEvent.contextMenu(screen.getByText('trigger'))
    return screen.findByRole('menuitem')
  }

  it('applies text-destructive + focus:bg-destructive/10 when variant="destructive"', async () => {
    renderMenuTree('destructive')
    const item = await openAndGetItem()

    expect(item.className).toContain('text-destructive')
    expect(item.className).toContain('focus:bg-destructive/10')
    expect(item.className).toContain('focus:text-destructive')
    // No raw red-* classes — the destructive token is theme-driven.
    expect(item.className).not.toMatch(/text-red-/)
  })

  it('does NOT apply text-destructive for the default variant', async () => {
    renderMenuTree()
    const item = await openAndGetItem()

    expect(item.className).not.toContain('text-destructive')
  })

  it('does NOT apply text-destructive when variant is explicitly "default"', async () => {
    renderMenuTree('default')
    const item = await openAndGetItem()

    expect(item.className).not.toContain('text-destructive')
  })
})

/**
 * Touch floor and reduced motion. Items grow to 44px on coarse pointers only
 * (`CHAT_ROW_MIN_H`), and the entry animation is skipped under reduced motion.
 * The important modifier is deliberate: `data-[state=open]:animate-in` outranks
 * a bare `motion-reduce:animate-none`.
 */
describe('ContextMenu touch floor and reduced motion', () => {
  function renderMenu(): void {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button">trigger</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy</ContextMenuItem>
          <ContextMenuItem variant="destructive" inset>
            Delete
          </ContextMenuItem>
          <ContextMenuCheckboxItem checked>Pinned</ContextMenuCheckboxItem>
          <ContextMenuRadioGroup value="a">
            <ContextMenuRadioItem value="a">Sort by name</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSub>
            <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
            <ContextMenuSubContent forceMount>
              <ContextMenuItem>Nested</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('trigger'))
  }

  it('gives every item row a 28px minimum that grows to 44px on coarse pointers', async () => {
    renderMenu()
    await screen.findAllByRole('menuitem')

    // Plain, destructive, checkbox, radio and sub-trigger rows, plus a nested item.
    for (const label of ['Copy', 'Delete', 'Pinned', 'Sort by name', 'More', 'Nested']) {
      const classes = screen.getByText(label).className.split(/\s+/)
      expect(classes, label).toContain('min-h-7')
      expect(classes, label).toContain('pointer-coarse:min-h-11')
    }
  })

  it('skips the content entry animation under reduced motion', async () => {
    renderMenu()
    const menus = await screen.findAllByRole('menu')

    expect(menus[0].className).toContain('motion-reduce:animate-none!')
    expect(menus[0].className).toContain('data-[state=open]:animate-in')
  })

  it('skips the sub-content entry animation under reduced motion', async () => {
    renderMenu()
    const nested = await screen.findByText('Nested')
    const subContent = nested.closest('[role="menu"]')

    expect(subContent).not.toBeNull()
    expect(subContent?.className).toContain('motion-reduce:animate-none!')
    expect(subContent?.className).toContain('data-[state=open]:animate-in')
  })

  it('keeps the destructive variant and the inset padding alongside the floor', async () => {
    renderMenu()
    const del = await screen.findByText('Delete')

    expect(del.className).toContain('text-destructive')
    expect(del.className).toContain('pl-8')
    expect(del.className).toContain('pointer-coarse:min-h-11')
  })
})
