import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@/types/project'
import { TerminalTabBar } from './TerminalTabBar'
import { KIND_PLURAL_LABELS } from './workspace/tab-context-menu'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    shellApi: {
      getAvailableShells: vi.fn().mockResolvedValue({
        success: true,
        data: { default: null, available: [] }
      })
    }
  }
})

vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (state: { projects: unknown[] }) => unknown) =>
    selector({ projects: [] })
  )
}))

// Same stateful stub as WorkspaceTabBar.test.tsx: opens the menu on
// `contextmenu` and renders items as clickable divs, avoiding the Radix
// portal/pointer plumbing that jsdom cannot drive.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  const ContextMenu = ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false)
    return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
  }
  const ContextMenuTrigger = ({
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
  }
  const ContextMenuContent = ({
    children,
    className
  }: {
    children: React.ReactNode
    className?: string
  }) => {
    const { open } = React.useContext(MenuCtx)
    if (!open) return null
    return (
      <div role="menu" className={className}>
        {children}
      </div>
    )
  }
  const ContextMenuItem = ({
    children,
    disabled,
    onSelect,
    variant
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
    variant?: 'default' | 'destructive'
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled ? '' : undefined}
      data-variant={variant}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </div>
  )
  const ContextMenuSeparator = () => <hr />
  return {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator
  }
})

function makeTerminal(id: string, name: string): Terminal {
  return { id, name } as Terminal
}

describe('TerminalTabBar', () => {
  it('keeps the bottom-panel terminal menu unchanged: Rename and Close only', async () => {
    render(
      <TerminalTabBar
        terminals={[makeTerminal('t1', 'Terminal 1'), makeTerminal('t2', 'Terminal 2')]}
        activeTerminalId="t1"
        onSelectTerminal={vi.fn()}
        onCloseTerminal={vi.fn()}
        onNewTerminal={vi.fn()}
        onRenameTerminal={vi.fn()}
        onReorderTerminals={vi.fn()}
      />
    )

    const tabEl = screen.getByText('Terminal 1').closest('.group') as HTMLElement
    expect(tabEl).toBeTruthy()
    fireEvent.contextMenu(tabEl)

    await screen.findByRole('menu')
    expect(screen.getByText('Rename')).toBeInTheDocument()
    expect(screen.getByText('Close')).toBeInTheDocument()

    // Workspace-pane bulk items must not leak into the bottom panel menu.
    expect(screen.queryByText(`Close Other ${KIND_PLURAL_LABELS.terminal}`)).not.toBeInTheDocument()
    expect(screen.queryByText(`Close All ${KIND_PLURAL_LABELS.terminal}`)).not.toBeInTheDocument()
    expect(screen.queryByText('Close Other Tabs')).not.toBeInTheDocument()
    expect(screen.queryByText('Close All Tabs')).not.toBeInTheDocument()
    expect(screen.queryByText('Copy Path')).not.toBeInTheDocument()
  })

  it('dispatches the shared Close menu item to onCloseTerminal', async () => {
    const onCloseTerminal = vi.fn()
    render(
      <TerminalTabBar
        terminals={[makeTerminal('t1', 'Terminal 1')]}
        activeTerminalId="t1"
        onSelectTerminal={vi.fn()}
        onCloseTerminal={onCloseTerminal}
        onNewTerminal={vi.fn()}
        onRenameTerminal={vi.fn()}
        onReorderTerminals={vi.fn()}
      />
    )

    const tabEl = screen.getByText('Terminal 1').closest('.group') as HTMLElement
    fireEvent.contextMenu(tabEl)
    fireEvent.click(await screen.findByText('Close'))

    expect(onCloseTerminal).toHaveBeenCalledTimes(1)
    expect(onCloseTerminal).toHaveBeenCalledWith('t1')
  })
})
