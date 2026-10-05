import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleBarShortcutsPopover } from './TitleBarShortcutsPopover'

// Issue #843: the quick-shortcuts popover must not list the desktop-only
// "New Browser Tab" entry on web (it would show an unbindable shortcut for a
// no-op action).
const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true } }))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useUpdateShortcut: () => vi.fn(),
  useResetShortcut: () => vi.fn()
}))

// ShortcutRecorder is stubbed below, so the store mock only needs the
// selector. `shortcuts` is keyed by id (the popover indexes shortcuts[id]).
vi.mock('@/stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: (selector: (s: { shortcuts: Record<string, unknown> }) => unknown) =>
    selector({
      shortcuts: {
        commandPalette: {
          id: 'commandPalette',
          label: 'Command Palette',
          description: '',
          defaultKey: 'ctrl+k'
        },
        newBrowserTab: {
          id: 'newBrowserTab',
          label: 'New Browser Tab',
          description: '',
          defaultKey: 'ctrl+shift+n'
        }
      }
    })
}))

vi.mock('@/components/ShortcutRecorder', () => ({
  ShortcutRecorder: ({ shortcut }: { shortcut: { label: string } }) => (
    <div data-testid="shortcut-row">{shortcut.label}</div>
  )
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        )
      )
    }
  }
})

describe('TitleBarShortcutsPopover web filter (#843)', () => {
  beforeEach(() => {
    tauriRef.current = true
  })

  function openPopover() {
    render(<TitleBarShortcutsPopover buttonClassName="" />)
    fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts menu/i }))
  }

  it('lists New Browser Tab on desktop', () => {
    openPopover()

    expect(screen.getAllByTestId('shortcut-row').length).toBe(2)
    expect(screen.getByText('New Browser Tab')).toBeInTheDocument()
  })

  it('omits New Browser Tab on web', () => {
    tauriRef.current = false
    openPopover()

    expect(screen.getAllByTestId('shortcut-row').length).toBe(1)
    expect(screen.queryByText('New Browser Tab')).not.toBeInTheDocument()
    expect(screen.getByText('Command Palette')).toBeInTheDocument()
  })
})
