import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTreeContextMenuContent } from '@/components/file-explorer/FileTreeContextMenu'

const mockIsTauriContext = vi.hoisted(() => vi.fn())

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

// Stub the Radix context-menu primitives so the test asserts the item labels
// that `FileTreeContextMenuContent` builds declaratively. The real primitives
// render via a portal + Radix positioning that is hard to assert in jsdom; the
// flat stub renders `<ContextMenuContent>` children inline so `getByText` can
// assert the capability-gated item set. The `ContextMenuTrigger` stub mirrors
// Radix's checkForDefaultPrevented (F2) so F1-type regressions surface in any
// trigger-based test that uses this mock. Mirrors the GlobalContextMenu stub.
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
        // F2: mirror Radix checkForDefaultPrevented — skip open if the child
        // handler called preventDefault.
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
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuSeparator: () => null
  }
})

const fileEntry: DirectoryEntry = {
  name: 'file.txt',
  path: '/proj/file.txt',
  type: 'file',
  extension: '.txt',
  size: 100,
  modifiedAt: 0
}

const dirEntry: DirectoryEntry = {
  name: 'src',
  path: '/proj/src',
  type: 'directory',
  extension: null,
  size: 0,
  modifiedAt: 0
}

function renderMenu(entry: DirectoryEntry): void {
  render(
    <FileTreeContextMenuContent
      entry={entry}
      onNewFile={vi.fn()}
      onNewFolder={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onCopyPath={vi.fn()}
      onCopy={vi.fn()}
      onCut={vi.fn()}
      onPaste={vi.fn()}
      onDuplicate={vi.fn()}
      onOpenInTerminal={vi.fn()}
      onOpenWithExternal={vi.fn()}
      onShowInFileManager={vi.fn()}
    />
  )
}

describe('FileTreeContextMenu capability gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hides Reveal in File Manager and Open with External App on web (file)', () => {
    mockIsTauriContext.mockReturnValue(false)
    renderMenu(fileEntry)

    expect(screen.queryByText('Show in File Manager')).not.toBeInTheDocument()
    expect(screen.queryByText('Open with External App')).not.toBeInTheDocument()
  })

  it('shows Reveal in File Manager and Open with External App on desktop (file)', () => {
    mockIsTauriContext.mockReturnValue(true)
    renderMenu(fileEntry)

    expect(screen.getByText('Show in File Manager')).toBeInTheDocument()
    expect(screen.getByText('Open with External App')).toBeInTheDocument()
  })

  it('hides Show in File Manager on web but keeps Open in Terminal (directory)', () => {
    mockIsTauriContext.mockReturnValue(false)
    renderMenu(dirEntry)

    expect(screen.queryByText('Show in File Manager')).not.toBeInTheDocument()
    // Open in Terminal works on web (server-side PTY).
    expect(screen.getByText('Open in Terminal')).toBeInTheDocument()
  })
})
