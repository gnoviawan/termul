import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalContextMenu } from '@/components/GlobalContextMenu'

// Hoisted refs to capture the Radix mock's onOpenChange callback so the test
// can trigger the menu-open state snapshot (the real Radix portal/positioning
// is hard to drive from jsdom). Mirrors the FileTreeContextMenu stub pattern.
const onOpenChangeRef = vi.hoisted(() => ({ current: null as ((open: boolean) => void) | null }))

// Stub text-edit-ops so the test asserts menu logic (disabled flags + click
// wiring), not clipboard plumbing. The real module's Tauri imports never load.
const textEditOps = vi.hoisted(() => ({
  copySelection: vi.fn(() => Promise.resolve(true)),
  cutSelection: vi.fn(() => Promise.resolve(true)),
  pasteIntoFocused: vi.fn(() => Promise.resolve(true)),
  selectAllFocused: vi.fn(() => true)
}))

vi.mock('@/lib/text-edit-ops', () => textEditOps)

// Mock isTauriContext defensively (mirrors FileTreeContextMenu pattern).
const mockIsTauriContext = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))

// Stub the Radix context-menu primitives. The real primitives render via a
// portal + Radix positioning that is hard to assert in jsdom; this stub
// renders items as buttons so the test asserts labels + disabled flags +
// click wiring. The ContextMenu mock captures onOpenChange so the test can
// fire the menu-open snapshot at a controlled time. The ContextMenuTrigger
// supports `asChild` + mirrors Radix's checkForDefaultPrevented so a child
// handler that re-introduces preventDefault (F1 regression) is caught.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  return {
    ContextMenu: ({
      children,
      onOpenChange
    }: {
      children: React.ReactNode
      onOpenChange?: (open: boolean) => void
    }) => {
      onOpenChangeRef.current = onOpenChange ?? null
      return <div data-testid="context-menu">{children}</div>
    },
    ContextMenuTrigger: ({
      children,
      asChild
    }: {
      children: React.ReactNode
      asChild?: boolean
    }) => {
      const merged = (e: React.MouseEvent) => {
        // F2: mirror Radix checkForDefaultPrevented — skip open if the child
        // handler called preventDefault.
        if (e.defaultPrevented) return
        e.preventDefault()
        onOpenChangeRef.current?.(true)
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
      return (
        <div data-testid="trigger" onContextMenu={merged}>
          {children}
        </div>
      )
    },
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="content">{children}</div>
    ),
    ContextMenuItem: ({
      children,
      disabled,
      onClick,
      onSelect
    }: {
      children: React.ReactNode
      disabled?: boolean
      onClick?: () => void
      onSelect?: () => void
    }) => (
      <button
        data-testid="item"
        disabled={disabled}
        onClick={() => {
          onClick?.()
          onSelect?.()
        }}
      >
        {children}
      </button>
    ),
    ContextMenuSeparator: () => <hr data-testid="separator" />,
    ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => (
      <span data-testid="shortcut">{children}</span>
    )
  }
})

/** Focus (or blur) the rendered input to control document.activeElement. */
function focusInput(focused: boolean): void {
  const input = screen.queryByTestId('surface-input')
  if (focused && input instanceof HTMLElement) {
    input.focus()
  } else if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

/**
 * P3: dispatch a capture-phase contextmenu event so the GlobalContextMenu's
 * capture-phase listener snapshots the current selection/focus state before
 * Radix moves focus to the first menu item.
 */
function dispatchContextMenu(): void {
  act(() => {
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
}

function openMenu(): void {
  act(() => {
    onOpenChangeRef.current?.(true)
  })
}

/** Find a menu item button by its label prefix (button textContent is "Copy Ctrl+C" etc.). */
function buttonByLabel(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}\\b`) }) as HTMLButtonElement
}

describe('GlobalContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    onOpenChangeRef.current = null
  })

  it('renders the wrapped children inside the trigger', () => {
    render(
      <GlobalContextMenu>
        <div data-testid="surface">app surface</div>
      </GlobalContextMenu>
    )
    expect(screen.getByTestId('surface')).toBeInTheDocument()
    expect(screen.getByTestId('context-menu')).toBeInTheDocument()
  })

  it('shows Copy/Cut/Separator/Paste/Select All and no Reload/Back/Inspect', () => {
    render(
      <GlobalContextMenu>
        <input data-testid="surface-input" />
      </GlobalContextMenu>
    )
    focusInput(true)
    dispatchContextMenu()
    openMenu()

    expect(screen.getByRole('button', { name: /^Copy\b/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Cut\b/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Paste\b/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Select All\b/ })).toBeInTheDocument()
    expect(screen.getByTestId('separator')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reload\b/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Back\b/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Inspect\b/ })).not.toBeInTheDocument()
  })

  it('enables Copy/Cut/Paste/Select All when a selection exists and a mutable editable is focused', () => {
    render(
      <GlobalContextMenu>
        <input data-testid="surface-input" defaultValue="hello world" />
      </GlobalContextMenu>
    )
    focusInput(true)
    const input = screen.getByTestId('surface-input') as HTMLInputElement
    input.setSelectionRange(0, 5)
    dispatchContextMenu()
    openMenu()

    expect(buttonByLabel('Copy').disabled).toBe(false)
    expect(buttonByLabel('Cut').disabled).toBe(false)
    expect(buttonByLabel('Paste').disabled).toBe(false)
    expect(buttonByLabel('Select All').disabled).toBe(false)
  })

  it('disables Copy/Cut but enables Paste/Select All when no selection but mutable editable focused', () => {
    render(
      <GlobalContextMenu>
        <input data-testid="surface-input" defaultValue="hello" />
      </GlobalContextMenu>
    )
    focusInput(true)
    dispatchContextMenu()
    openMenu()

    expect(buttonByLabel('Copy').disabled).toBe(true)
    expect(buttonByLabel('Cut').disabled).toBe(true)
    expect(buttonByLabel('Paste').disabled).toBe(false)
    expect(buttonByLabel('Select All').disabled).toBe(false)
  })

  it('enables Copy but disables Cut/Paste/Select All when a selection exists but no editable focused', () => {
    // Mock window.getSelection to return a non-empty selection (generic page text).
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'selected text'
    } as unknown as Selection)
    render(
      <GlobalContextMenu>
        <div data-testid="surface">no editable here</div>
      </GlobalContextMenu>
    )
    focusInput(false)
    dispatchContextMenu()
    openMenu()

    expect(buttonByLabel('Copy').disabled).toBe(false)
    expect(buttonByLabel('Cut').disabled).toBe(true)
    expect(buttonByLabel('Paste').disabled).toBe(true)
    // P9: Select All disabled when no mutable editable is focused.
    expect(buttonByLabel('Select All').disabled).toBe(true)
  })

  it('disables Copy/Cut/Paste/Select All when no selection and no editable focused', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => ''
    } as unknown as Selection)
    render(
      <GlobalContextMenu>
        <div data-testid="surface">no editable here</div>
      </GlobalContextMenu>
    )
    focusInput(false)
    dispatchContextMenu()
    openMenu()

    expect(buttonByLabel('Copy').disabled).toBe(true)
    expect(buttonByLabel('Cut').disabled).toBe(true)
    expect(buttonByLabel('Paste').disabled).toBe(true)
    // P9: Select All disabled when no mutable editable is focused.
    expect(buttonByLabel('Select All').disabled).toBe(true)
  })

  it('wires Copy/Cut/Paste/Select All clicks to text-edit-ops', () => {
    render(
      <GlobalContextMenu>
        <input data-testid="surface-input" defaultValue="hello world" />
      </GlobalContextMenu>
    )
    focusInput(true)
    const input = screen.getByTestId('surface-input') as HTMLInputElement
    input.setSelectionRange(0, 5)
    dispatchContextMenu()
    openMenu()

    buttonByLabel('Copy').click()
    expect(textEditOps.copySelection).toHaveBeenCalledTimes(1)

    buttonByLabel('Cut').click()
    expect(textEditOps.cutSelection).toHaveBeenCalledTimes(1)

    buttonByLabel('Paste').click()
    expect(textEditOps.pasteIntoFocused).toHaveBeenCalledTimes(1)

    buttonByLabel('Select All').click()
    expect(textEditOps.selectAllFocused).toHaveBeenCalledTimes(1)
  })
})
