import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalControls } from './MobileTerminalControls'

const { write, readText } = vi.hoisted(() => ({
  write: vi.fn(),
  readText: vi.fn()
}))

vi.mock('@/lib/terminal-api', () => ({
  terminalApi: { write }
}))
vi.mock('@/lib/clipboard-api', () => ({
  clipboardApi: { readText }
}))

describe('MobileTerminalControls', () => {
  beforeEach(() => {
    write.mockReset()
    readText.mockReset()
    write.mockResolvedValue({ success: true, data: undefined })
  })

  it('writes terminal escape/control sequences', () => {
    render(<MobileTerminalControls terminalId="pty-1" />)
    fireEvent.click(screen.getByText('Esc'))
    fireEvent.click(screen.getByText('Ctrl+C'))
    fireEvent.click(screen.getByText('↑'))
    expect(write).toHaveBeenNthCalledWith(1, 'pty-1', '\u001b')
    expect(write).toHaveBeenNthCalledWith(2, 'pty-1', '\u0003')
    expect(write).toHaveBeenNthCalledWith(3, 'pty-1', '\u001b[A')
  })

  it('pastes browser clipboard text', async () => {
    readText.mockResolvedValue({ success: true, data: 'echo mobile' })
    render(<MobileTerminalControls terminalId="pty-1" />)
    fireEvent.click(screen.getByText('Paste'))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('pty-1', 'echo mobile'))
  })
})
