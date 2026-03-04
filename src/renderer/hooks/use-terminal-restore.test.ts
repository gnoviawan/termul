import { describe, it, expect } from 'vitest'
import { normalizeShellForStartup } from './use-terminal-restore'

describe('normalizeShellForStartup', () => {
  it('returns powershell when shell is empty', () => {
    expect(normalizeShellForStartup('')).toBe('powershell')
    expect(normalizeShellForStartup(undefined)).toBe('powershell')
  })

  it('normalizes cmd to powershell in tauri windows context', () => {
    Object.defineProperty(window as unknown as Record<string, unknown>, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true
    })

    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true
    })

    expect(normalizeShellForStartup('cmd')).toBe('powershell')
    expect(normalizeShellForStartup('CMD.EXE')).toBe('powershell')
    expect(normalizeShellForStartup(' powershell ')).toBe(' powershell ')

    Object.defineProperty(window as unknown as Record<string, unknown>, '__TAURI_INTERNALS__', {
      value: undefined,
      configurable: true
    })
  })

  it('does not normalize cmd outside tauri context', () => {
    Object.defineProperty(window as unknown as Record<string, unknown>, '__TAURI_INTERNALS__', {
      value: undefined,
      configurable: true
    })

    expect(normalizeShellForStartup('cmd')).toBe('cmd')
  })
})
