import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileTerminalControls } from './MobileTerminalControls'

// Issue #859: at 390px the key bar's horizontal scroll pushed the arrow keys
// and PgUp/PgDn off-screen. The bar now wraps its keys into rows instead of
// scrolling, so every key stays visible.
vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/clipboard-api', () => ({
  clipboardApi: { readText: vi.fn().mockResolvedValue({ success: true, data: '' }) }
}))

vi.mock('@/lib/terminal-api', () => ({
  terminalApi: { write: vi.fn().mockResolvedValue({ success: true }) }
}))

const KEY_LABELS = ['Esc', 'Tab', 'Ctrl+C', '←', '↑', '↓', '→', 'PgUp', 'PgDn'] as const

describe('MobileTerminalControls key bar (#859)', () => {
  it('renders every key without a scrolling container (wrap layout)', () => {
    render(<MobileTerminalControls terminalId="t1" />)

    for (const label of KEY_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }

    // The key row wraps instead of horizontally scrolling: no overflow-x-auto.
    const escButton = screen.getByRole('button', { name: 'Esc' })
    const keyRow = escButton.parentElement
    expect(keyRow).not.toBeNull()
    expect(keyRow?.className).not.toContain('overflow-x-auto')
    expect(keyRow?.className).toContain('flex-wrap')
  })
})
