import { describe, expect, it, vi } from 'vitest'
import { handleTerminalTakeoverEvent, resolveTerminalTakeoverState } from './terminal-takeover'

describe('resolveTerminalTakeoverState', () => {
  it('returns null when terminal id does not match', () => {
    expect(
      resolveTerminalTakeoverState('terminal-1', {
        terminalId: 'terminal-2',
        clientType: 'web'
      })
    ).toBeNull()
  })

  it('locks tauri on web takeover', () => {
    expect(
      resolveTerminalTakeoverState('terminal-1', {
        terminalId: 'terminal-1',
        clientType: 'web'
      })
    ).toEqual({ isOwner: false, isSuspended: true })
  })

  it('unlocks tauri on tauri takeover', () => {
    expect(
      resolveTerminalTakeoverState('terminal-1', {
        terminalId: 'terminal-1',
        clientType: 'tauri'
      })
    ).toEqual({ isOwner: true, isSuspended: false })
  })

  it('applies takeover state through callback wrapper', () => {
    const applyState = vi.fn()

    handleTerminalTakeoverEvent(
      'terminal-1',
      {
        terminalId: 'terminal-1',
        clientType: 'web'
      },
      applyState
    )

    expect(applyState).toHaveBeenCalledWith({ isOwner: false, isSuspended: true })
  })
})
