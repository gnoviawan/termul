/**
 * The rename notice against the app's real Toaster. Each `launch` reloads the
 * modules, so the boot classification runs against storage exactly as a new
 * page load would find it.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(async () => undefined)
}))

async function launch(): Promise<void> {
  cleanup()
  vi.resetModules()
  const { Toaster } = await import('@/components/ui/sonner')
  const { useRenameNotice } = await import('./use-rename-notice')
  function Harness(): React.JSX.Element {
    useRenameNotice()
    return <Toaster />
  }
  render(<Harness />)
  // sonner defers each toast create to a setTimeout.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useRenameNotice', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('shows once on a device an earlier version already used', async () => {
    localStorage.setItem('termul.deviceId', 'device-from-0.4.60')

    await launch()

    expect(screen.getByText('Termul is now Troupe')).toBeTruthy()
    expect(
      screen.getByText(
        "It's the same app with a new name. Your projects, chats, settings and sign-ins are unchanged."
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Close toast' })).toBeNull()
  })

  it('never shows on a fresh install, even after the app writes its own keys', async () => {
    await launch()

    expect(screen.queryByText('Termul is now Troupe')).toBeNull()
    expect(localStorage.getItem('termul.renameNotice')).toBe('fresh')

    localStorage.setItem('termul.deviceId', 'device-minted-this-session')
    await launch()

    expect(screen.queryByText('Termul is now Troupe')).toBeNull()
  })

  it('never shows when the only stored keys belong to another app on the origin', async () => {
    localStorage.setItem('other-app.session', 'x')

    await launch()

    expect(screen.queryByText('Termul is now Troupe')).toBeNull()
    expect(localStorage.getItem('termul.renameNotice')).toBe('fresh')
  })

  it('stays hidden when storage cannot be read', async () => {
    localStorage.setItem('termul.deviceId', 'device-from-0.4.60')
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    try {
      await launch()
    } finally {
      getItem.mockRestore()
    }

    expect(screen.queryByText('Termul is now Troupe')).toBeNull()
  })

  it('does not show again after Got it', async () => {
    localStorage.setItem('termul.deviceId', 'device-from-0.4.60')
    await launch()

    await act(async () => {
      screen.getByRole('button', { name: 'Got it' }).click()
    })

    expect(localStorage.getItem('termul.renameNotice')).toBe('dismissed')

    await launch()

    expect(screen.queryByText('Termul is now Troupe')).toBeNull()
  })

  it('shows again on the next launch when the app closed before a dismiss', async () => {
    localStorage.setItem('termul.deviceId', 'device-from-0.4.60')
    await launch()
    await launch()

    expect(screen.getByText('Termul is now Troupe')).toBeTruthy()
  })
})
