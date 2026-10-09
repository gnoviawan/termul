import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ContextMenuContent } from '@/components/ui/context-menu'
import { ExplorerInlineInputProvider } from './explorer-inline-input'
import { FileTreeNode } from './FileTreeNode'

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({
    startFileDrag: vi.fn()
  })
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
        selection="none"
        isLoading={false}
        onClick={vi.fn()}
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
        selection="none"
        isLoading={false}
        onClick={vi.fn()}
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
        selection="none"
        isLoading={false}
        onClick={vi.fn()}
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
        selection="none"
        isLoading={false}
        onClick={vi.fn()}
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

describe('FileTreeNode redesign states', () => {
  const file = {
    path: '/project/src/app.ts',
    name: 'app.ts',
    type: 'file' as const,
    extension: 'ts',
    size: 10,
    modifiedAt: 0
  }
  const folder = {
    path: '/project/src',
    name: 'src',
    type: 'directory' as const,
    extension: null,
    size: 0,
    modifiedAt: 0
  }
  const baseProps = {
    depth: 0,
    isExpanded: false,
    isLoading: false,
    onClick: vi.fn(),
    onContextMenu: vi.fn()
  }

  it('uses the keycap for the primary selection and a wash for other selected rows', () => {
    const { rerender } = render(<FileTreeNode {...baseProps} entry={file} selection="primary" />)
    const row = document.querySelector('[data-path="/project/src/app.ts"]')
    expect(row).toHaveClass('keycap', 'text-foreground')
    expect(row).not.toHaveClass('bg-accent')

    rerender(<FileTreeNode {...baseProps} entry={file} selection="multi" />)
    expect(row).toHaveClass('bg-foreground/[0.06]')
    expect(row).not.toHaveClass('keycap')
  })

  it('shows the git letter with a tinted name, and a dot on folders with changes', () => {
    const { rerender } = render(
      <FileTreeNode {...baseProps} entry={file} selection="none" gitStatus="modified" />
    )
    expect(screen.getByText('app.ts')).toHaveClass('text-diff-modified')
    expect(screen.getByTitle('Modified')).toHaveTextContent('M')

    rerender(<FileTreeNode {...baseProps} entry={file} selection="none" gitStatus="untracked" />)
    expect(screen.getByText('app.ts')).toHaveClass('text-diff-added')
    expect(screen.getByTitle('Untracked')).toHaveTextContent('U')

    rerender(<FileTreeNode {...baseProps} entry={folder} selection="none" hasGitChanges />)
    expect(screen.getByRole('img', { name: 'Contains changes' })).toHaveClass('bg-diff-modified')
  })

  it('dims git-ignored names without fading the whole row', () => {
    render(<FileTreeNode {...baseProps} entry={{ ...file, ignored: true }} selection="none" />)
    expect(screen.getByText('app.ts')).toHaveClass('text-muted-foreground/60')
    expect(document.querySelector('[data-path="/project/src/app.ts"]')).not.toHaveClass(
      'opacity-50'
    )
  })

  it('renames in place and selects the name without its extension', () => {
    render(
      <ExplorerInlineInputProvider
        value={{
          inlineInput: {
            parentPath: '/project/src',
            type: 'file',
            mode: 'rename',
            existingEntry: file
          },
          value: 'app.ts',
          setValue: vi.fn(),
          onSubmit: vi.fn(),
          onCancel: vi.fn()
        }}
      >
        <FileTreeNode {...baseProps} entry={file} selection="primary" />
      </ExplorerInlineInputProvider>
    )
    const row = document.querySelector('[data-path="/project/src/app.ts"]')
    const input = screen.getByPlaceholderText('New name...') as HTMLInputElement
    expect(row).toContainElement(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(3)
  })

  it('draws an indent guide for an expanded folder and brightens it when active', () => {
    const { rerender } = render(
      <FileTreeNode
        {...baseProps}
        entry={folder}
        selection="none"
        isExpanded
        {...{ children: [] }}
      />
    )
    const guide = screen.getByTestId('tree-indent-guide')
    expect(guide).toHaveClass('bg-border')
    expect(guide).toHaveStyle({ left: '11px' })

    rerender(
      <FileTreeNode
        {...baseProps}
        entry={folder}
        selection="none"
        isExpanded
        isGuideActive
        {...{ children: [] }}
      />
    )
    expect(screen.getByTestId('tree-indent-guide')).toHaveClass('bg-muted-foreground/40')
  })

  it('shows the create row at the top of the folder children', () => {
    render(
      <ExplorerInlineInputProvider
        value={{
          inlineInput: { parentPath: '/project/src', type: 'file', mode: 'create' },
          value: '',
          setValue: vi.fn(),
          onSubmit: vi.fn(),
          onCancel: vi.fn()
        }}
      >
        <FileTreeNode
          {...baseProps}
          entry={folder}
          selection="none"
          isExpanded
          {...{ children: [file] }}
        />
      </ExplorerInlineInputProvider>
    )
    const input = screen.getByPlaceholderText('File name...')
    const childRow = document.querySelector('[data-path="/project/src/app.ts"]')
    expect(childRow).not.toBeNull()
    // The create row comes before the first child row.
    expect(
      input.compareDocumentPosition(childRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
