import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalContextMenu } from '@/components/GlobalContextMenu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

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

/** Focus (or blur) the rendered input to control document.activeElement. */
function focusInput(focused: boolean): void {
  const input = screen.queryByTestId('surface-input')
  if (focused && input instanceof HTMLElement) {
    input.focus()
  } else if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

function itemByLabel(label: string): HTMLElement {
  return screen.getByRole('menuitem', { name: new RegExp(`^${label}\\b`) })
}

function isDisabled(label: string): boolean {
  return itemByLabel(label).getAttribute('aria-disabled') === 'true'
}

function menuItemLabels(): Array<string | null> {
  return screen.getAllByRole('menuitem').map((item) => item.textContent)
}

describe('GlobalContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('renders the wrapped children with the menu closed', () => {
    render(
      <GlobalContextMenu>
        <div data-testid="surface">app surface</div>
      </GlobalContextMenu>
    )
    expect(screen.getByTestId('surface')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('shows Copy/Cut/Separator/Paste/Select All and no Reload/Back/Inspect', () => {
    render(
      <GlobalContextMenu>
        <input data-testid="surface-input" />
      </GlobalContextMenu>
    )
    focusInput(true)
    fireEvent.contextMenu(screen.getByTestId('surface-input'))

    expect(menuItemLabels()).toEqual([
      'Copy Ctrl+C',
      'Cut Ctrl+X',
      'Paste Ctrl+V',
      'Select All Ctrl+A'
    ])
    expect(screen.getByRole('separator')).toBeInTheDocument()
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
    fireEvent.contextMenu(input)

    expect(isDisabled('Copy')).toBe(false)
    expect(isDisabled('Cut')).toBe(false)
    expect(isDisabled('Paste')).toBe(false)
    expect(isDisabled('Select All')).toBe(false)
  })

  it('disables Copy/Cut but enables Paste/Select All when no selection but mutable editable focused', () => {
    render(
      <GlobalContextMenu>
        <input data-testid="surface-input" defaultValue="hello" />
      </GlobalContextMenu>
    )
    focusInput(true)
    fireEvent.contextMenu(screen.getByTestId('surface-input'))

    expect(isDisabled('Copy')).toBe(true)
    expect(isDisabled('Cut')).toBe(true)
    expect(isDisabled('Paste')).toBe(false)
    expect(isDisabled('Select All')).toBe(false)
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
    fireEvent.contextMenu(screen.getByTestId('surface'))

    expect(isDisabled('Copy')).toBe(false)
    expect(isDisabled('Cut')).toBe(true)
    expect(isDisabled('Paste')).toBe(true)
    // P9: Select All disabled when no mutable editable is focused.
    expect(isDisabled('Select All')).toBe(true)
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
    fireEvent.contextMenu(screen.getByTestId('surface'))

    expect(isDisabled('Copy')).toBe(true)
    expect(isDisabled('Cut')).toBe(true)
    expect(isDisabled('Paste')).toBe(true)
    // P9: Select All disabled when no mutable editable is focused.
    expect(isDisabled('Select All')).toBe(true)
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

    fireEvent.contextMenu(input)
    fireEvent.click(itemByLabel('Copy'))
    expect(textEditOps.copySelection).toHaveBeenCalledTimes(1)

    input.focus()
    fireEvent.contextMenu(input)
    fireEvent.click(itemByLabel('Cut'))
    expect(textEditOps.cutSelection).toHaveBeenCalledTimes(1)

    input.focus()
    fireEvent.contextMenu(input)
    fireEvent.click(itemByLabel('Paste'))
    expect(textEditOps.pasteIntoFocused).toHaveBeenCalledTimes(1)

    input.focus()
    fireEvent.contextMenu(input)
    fireEvent.click(itemByLabel('Select All'))
    expect(textEditOps.selectAllFocused).toHaveBeenCalledTimes(1)
  })
})

describe('GlobalContextMenu isolation from nested custom menus', () => {
  function renderNested(): void {
    render(
      <GlobalContextMenu>
        <div data-testid="app-surface">app surface</div>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div data-testid="custom-row">custom row</div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Rename</ContextMenuItem>
            <ContextMenuItem>Delete</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </GlobalContextMenu>
    )
  }

  it('opens only the custom menu when its row is right-clicked', () => {
    renderNested()
    fireEvent.contextMenu(screen.getByTestId('custom-row'))

    expect(menuItemLabels()).toEqual(['Rename', 'Delete'])
  })

  it('opens only the global menu outside the custom row', () => {
    renderNested()
    fireEvent.contextMenu(screen.getByTestId('app-surface'))

    expect(menuItemLabels()).toEqual([
      'Copy Ctrl+C',
      'Cut Ctrl+X',
      'Paste Ctrl+V',
      'Select All Ctrl+A'
    ])
  })
})
