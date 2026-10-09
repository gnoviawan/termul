import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalControls } from './MobileTerminalControls'

const { writeMock, readTextMock, toastErrorMock } = vi.hoisted(() => ({
  writeMock: vi.fn(),
  readTextMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

vi.mock('@/lib/clipboard-api', () => ({
  clipboardApi: { readText: readTextMock }
}))

vi.mock('@/lib/terminal-api', () => ({
  terminalApi: { write: writeMock }
}))

// [visible text, spoken name, escape sequence], in on-screen order.
const KEYS = [
  ['Esc', 'Esc, escape', '\u001b'],
  ['Tab', 'Tab', '\t'],
  ['Ctrl+C', 'Ctrl+C, interrupt', '\u0003'],
  ['←', 'Left arrow', '\u001b[D'],
  ['↑', 'Up arrow', '\u001b[A'],
  ['↓', 'Down arrow', '\u001b[B'],
  ['→', 'Right arrow', '\u001b[C'],
  ['PgUp', 'PgUp, page up', '\u001b[5~'],
  ['PgDn', 'PgDn, page down', '\u001b[6~']
] as const

const TOGGLE_NAME = 'Show/hide key bar'
const BUTTON_NAMES = [TOGGLE_NAME, 'Paste', ...KEYS.map(([, name]) => name)]

function keyButtons(): HTMLElement[] {
  return KEYS.map(([, name]) => screen.getByRole('button', { name }))
}

beforeEach(() => {
  writeMock.mockReset().mockResolvedValue({ success: true })
  readTextMock.mockReset().mockResolvedValue({ success: true, data: '' })
  toastErrorMock.mockReset()
})

// Issue #859: at 390px the key bar's horizontal scroll pushed the arrow keys
// and PgUp/PgDn off-screen. The bar now wraps its keys into rows instead of
// scrolling, so every key stays visible.
describe('MobileTerminalControls key bar (#859)', () => {
  it('renders every key without a scrolling container (wrap layout)', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    for (const [, name] of KEYS) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }

    // The key row wraps instead of horizontally scrolling: no overflow-x-auto.
    const keyRow = screen.getByRole('button', { name: 'Esc, escape' }).parentElement
    expect(keyRow).not.toBeNull()
    expect(keyRow?.className).not.toContain('overflow-x-auto')
    expect(keyRow?.className).toContain('flex-wrap')
  })
})

describe('MobileTerminalControls structure', () => {
  it('puts the toggle, Paste and the nine keys in a "Terminal keys" group that wraps', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const group = screen.getByRole('group', { name: 'Terminal keys' })
    expect(within(group).getAllByRole('button')).toHaveLength(BUTTON_NAMES.length)
    for (const name of BUTTON_NAMES) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument()
    }

    expect(group).toHaveClass('flex-wrap')
    expect(group).not.toHaveClass('overflow-x-auto')
    // The group is the wrap container itself, not a wrapper around the keys only.
    for (const button of within(group).getAllByRole('button')) {
      expect(button.parentElement).toBe(group)
    }
  })

  it('keeps the key set and on-screen order (toggle, Paste, then the nine keys)', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const group = screen.getByRole('group', { name: 'Terminal keys' })
    const names = within(group)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim())
    expect(names).toEqual(BUTTON_NAMES)
  })

  it('keeps the bottom safe-area inset on the bar shell', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const shell = screen.getByRole('group', { name: 'Terminal keys' }).parentElement
    expect(shell).toHaveClass('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
  })

  it('sizes every button to the 44px floor (h-11 min-w-11)', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(11)
    for (const button of buttons) {
      expect(button).toHaveClass('h-11', 'min-w-11')
      // size="sm" supplies h-9; tailwind-merge must drop it in favour of h-11.
      expect(button).not.toHaveClass('h-9')
      expect(button).not.toHaveClass('h-10')
      expect(button).not.toHaveClass('min-w-10')
    }
  })
})

describe('MobileTerminalControls accessible names', () => {
  it('resolves each exact name to exactly one button', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    for (const name of BUTTON_NAMES) {
      expect(screen.getAllByRole('button', { name })).toHaveLength(1)
    }
  })

  it('starts every text key name with its visible text', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    for (const [label, name] of KEYS) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveTextContent(label)
      // Spoken names must contain the visible text. The three arrows are
      // symbols, so their word names are the exception.
      if (/^[A-Za-z]/.test(label)) {
        expect(name.startsWith(label)).toBe(true)
      }
    }
  })

  it('names Paste by its visible text', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    expect(screen.getByRole('button', { name: 'Paste' })).toHaveTextContent('Paste')
  })
})

describe('MobileTerminalControls show/hide key bar', () => {
  it('exposes aria-expanded and aria-controls pointing at the Terminal keys group', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const toggle = screen.getByRole('button', { name: TOGGLE_NAME })
    const group = screen.getByRole('group', { name: 'Terminal keys' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(group.id).not.toBe('')
    expect(toggle).toHaveAttribute('aria-controls', group.id)
  })

  it('hides only the nine keys when collapsed and restores them on the second tap', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const toggle = screen.getByRole('button', { name: TOGGLE_NAME })
    const paste = screen.getByRole('button', { name: 'Paste' })
    const keys = keyButtons()
    for (const key of keys) expect(key).not.toHaveClass('hidden')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    for (const key of keys) expect(key).toHaveClass('hidden')
    // Toggle, Paste and the group stay rendered and visible.
    expect(toggle).not.toHaveClass('hidden')
    expect(paste).not.toHaveClass('hidden')
    expect(screen.getByRole('group', { name: 'Terminal keys' })).toBeInTheDocument()
    // The name is static: state lives in aria-expanded.
    expect(screen.getByRole('button', { name: TOGGLE_NAME })).toBe(toggle)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    for (const key of keys) expect(key).not.toHaveClass('hidden')
  })
})

describe('MobileTerminalControls key taps', () => {
  it('writes each key its own escape sequence to the terminal', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    for (const [, name, sequence] of KEYS) {
      writeMock.mockClear()
      fireEvent.click(screen.getByRole('button', { name }))
      expect(writeMock).toHaveBeenCalledTimes(1)
      expect(writeMock).toHaveBeenCalledWith('t1', sequence)
    }
  })

  it('toasts the existing error when a key write fails', async () => {
    writeMock.mockResolvedValueOnce({ success: false, error: 'pty gone' })
    render(<MobileTerminalControls terminalId="t1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C, interrupt' }))

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Terminal write failed: pty gone')
    })
  })
})

describe('MobileTerminalControls Paste', () => {
  it('reads the clipboard and writes the text to the terminal', async () => {
    readTextMock.mockResolvedValueOnce({ success: true, data: 'ls -la' })
    render(<MobileTerminalControls terminalId="t1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith('t1', 'ls -la')
    })
    expect(readTextMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('does not write when the clipboard is empty', async () => {
    render(<MobileTerminalControls terminalId="t1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))

    await waitFor(() => {
      expect(readTextMock).toHaveBeenCalledTimes(1)
    })
    // Let paste() run past its awaited clipboard read before asserting that
    // nothing was written; waitFor alone passes the moment readText is called.
    await act(async () => {
      await readTextMock.mock.results[0]?.value
    })
    expect(writeMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('toasts the existing error when the clipboard read fails', async () => {
    readTextMock.mockResolvedValueOnce({ success: false, error: 'denied', code: 'READ_ERROR' })
    render(<MobileTerminalControls terminalId="t1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Clipboard read failed: denied')
    })
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('toasts the existing error when the paste write fails', async () => {
    readTextMock.mockResolvedValueOnce({ success: true, data: 'echo hi' })
    writeMock.mockResolvedValueOnce({ success: false, error: 'pty gone' })
    render(<MobileTerminalControls terminalId="t1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Paste failed: pty gone')
    })
  })
})

describe('MobileTerminalControls pointer-down focus guard', () => {
  it('prevents default on pointer-down for the toggle, Paste and every key', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    // fireEvent returns false when the event's default was prevented, which
    // is what keeps xterm focused and the on-screen keyboard up.
    for (const name of BUTTON_NAMES) {
      expect(fireEvent.pointerDown(screen.getByRole('button', { name }))).toBe(false)
    }
  })

  it('still fires click after the pointer-down guard', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    const key = screen.getByRole('button', { name: 'Tab' })
    fireEvent.pointerDown(key)
    fireEvent.click(key)
    expect(writeMock).toHaveBeenCalledWith('t1', '\t')

    const toggle = screen.getByRole('button', { name: TOGGLE_NAME })
    fireEvent.pointerDown(toggle)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
