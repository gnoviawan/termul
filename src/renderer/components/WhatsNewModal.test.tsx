import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { WhatsNewModal } from './WhatsNewModal'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/tauri-opener-api', () => ({
  openerApi: { openUrlWithSystemBrowser: vi.fn() }
}))

function Harness({
  onClose,
  initialOpen = true
}: {
  onClose: () => void
  initialOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  return (
    <WhatsNewModal
      isOpen={open}
      version="0.4.22"
      notes={null}
      htmlUrl={null}
      onClose={() => {
        onClose()
        setOpen(false)
      }}
    />
  )
}

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

// The modal cannot open on the mobile shell today (App.tsx gates it on
// `isTauriContext()`, which is false there), so these tests set the store flag
// directly to prove the registration the triage adopted (L-31).
describe('WhatsNewModal overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers while open and system back calls the owner close once and consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)

      expect(stackIds()).toHaveLength(1)
      expect(stackIds()[0]).toMatch(/^whats-new-modal:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      expect(onClose).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByText("What's New")).not.toBeInTheDocument(), {
        timeout: 3000
      })
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by Got it consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Got it' }))

      await waitForSentinelDepth(0)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does not register while closed', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      render(<Harness onClose={vi.fn()} initialOpen={false} />)
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)

      expect(stackIds()).toEqual([])
      fireEvent.keyDown(window, { key: 'Escape' })
      await settleOverlayBackStack()

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
