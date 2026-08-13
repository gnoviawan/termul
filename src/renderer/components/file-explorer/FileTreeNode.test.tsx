import { fireEvent, render, screen } from '@testing-library/react'
import { ContextMenuContent } from '@/components/ui/context-menu'
import type { SVGProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FileTreeNode } from './FileTreeNode'

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({
    startFileDrag: vi.fn()
  })
}))

vi.mock('./file-icon-map', () => ({
  getFileIcon: () => (props: SVGProps<SVGSVGElement>) => <svg data-testid="file-icon" {...props} />
}))

// Stub the Radix context-menu primitives with the stateful F2 pattern: the
// trigger opens on `contextmenu` (only if the child's onContextMenu did not
// call preventDefault — mirrors Radix's checkForDefaultPrevented), content
// renders only while open, Escape closes.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false)
      return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
    },
    ContextMenuTrigger: ({
      children,
      asChild
    }: {
      children: React.ReactNode
      asChild?: boolean
    }) => {
      const { setOpen } = React.useContext(MenuCtx)
      const merged = (e: React.MouseEvent) => {
        if (e.defaultPrevented) return
        e.preventDefault()
        setOpen(true)
      }
      if (asChild && React.isValidElement(children)) {
        const child = children as React.ReactElement<{
          onContextMenu?: (e: React.MouseEvent) => void
        }>
        return React.cloneElement(child, {
          onContextMenu: (e: React.MouseEvent) => {
            child.props.onContextMenu?.(e)
            merged(e)
          }
        })
      }
      return <div onContextMenu={merged}>{children}</div>
    },
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(MenuCtx)
      if (!open) return null
      return <div>{children}</div>
    }
  }
})

describe('FileTreeNode', () => {
  it('keeps long names on the truncate path without forcing the row wider', () => {
    const longName =
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxx_rev.docx'

    render(
      <FileTreeNode
        entry={{
          path: `/project/${longName}`,
          name: longName,
          type: 'file',
          extension: 'docx',
          size: 1024,
          modifiedAt: Date.UTC(2026, 5, 10)
        }}
        depth={0}
        isExpanded={false}
        isSelected={false}
        isLoading={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    const nameEl = screen.getByText(longName)
    expect(nameEl).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(nameEl.parentElement).toHaveClass('min-w-0', 'overflow-hidden')
  })

  it('exposes the entry path via data-path for header-action reveal (GH-540)', () => {
    render(
      <FileTreeNode
        entry={{
          path: '/project/src/deep',
          name: 'deep',
          type: 'directory',
          extension: null,
          size: 0,
          modifiedAt: Date.UTC(2026, 5, 10)
        }}
        depth={1}
        isExpanded={false}
        isSelected={false}
        isLoading={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    const row = document.querySelector('[data-path="/project/src/deep"]')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('deep')
  })

  it('wraps the row in a Radix ContextMenu trigger that opens on right-click (F3 + F1/F2 guard)', () => {
    const onContextMenu = vi.fn()
    render(
      <FileTreeNode
        entry={{
          path: '/project/file.txt',
          name: 'file.txt',
          type: 'file',
          extension: '.txt',
          size: 100,
          modifiedAt: 0
        }}
        depth={0}
        isExpanded={false}
        isSelected={false}
        isLoading={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={onContextMenu}
        renderContextMenu={() => (
          <ContextMenuContent>
            <span data-testid="node-menu-content">Rename file.txt</span>
          </ContextMenuContent>
        )}
      />
    )

    // Content is gated behind the open state — not visible before right-click.
    expect(screen.queryByTestId('node-menu-content')).not.toBeInTheDocument()

    // Right-click fires the child's onContextMenu (selection seeding), then the
    // F2 stub opens the menu (defaultPrevented is false because F1 removed
    // preventDefault from the real handlers — a re-introduction would skip open).
    fireEvent.contextMenu(screen.getByText('file.txt'))
    expect(onContextMenu).toHaveBeenCalledTimes(1)

    expect(screen.getByTestId('node-menu-content')).toBeInTheDocument()
    expect(screen.getByText('Rename file.txt')).toBeInTheDocument()
  })

  it('wires renderContextMenu to supply the declarative menu content (F3)', () => {
    const renderContextMenu = vi.fn(() => (
      <ContextMenuContent>
        <span data-testid="wired-content">Delete</span>
      </ContextMenuContent>
    ))
    render(
      <FileTreeNode
        entry={{
          path: '/project/src',
          name: 'src',
          type: 'directory',
          extension: null,
          size: 0,
          modifiedAt: 0
        }}
        depth={0}
        isExpanded={false}
        isSelected={false}
        isLoading={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        renderContextMenu={renderContextMenu}
      />
    )

    // renderContextMenu is invoked with the entry to build the declarative content.
    expect(renderContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'src', path: '/project/src', type: 'directory' })
    )

    // Content appears only after right-click opens the menu.
    expect(screen.queryByTestId('wired-content')).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText('src'))
    expect(screen.getByTestId('wired-content')).toBeInTheDocument()
  })
})
