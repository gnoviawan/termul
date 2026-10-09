import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ImageLightbox } from './image-lightbox'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function renderLightbox(): HTMLElement {
  render(
    <ImageLightbox src="/full.png" alt="Diagram">
      <img src="/thumb.png" alt="Diagram" />
    </ImageLightbox>
  )
  return screen.getByRole('button', { name: 'Open image: Diagram' })
}

function stackIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

describe('ui/image-lightbox overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('opens from the thumbnail and registers while open', async () => {
      const thumbnail = renderLightbox()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      fireEvent.click(thumbnail)

      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(stackIds()[0]).toMatch(/^image-lightbox:/)
      await waitForSentinelDepth(1)
    })

    it('system back closes it, consumes the sentinel and returns focus to the thumbnail button', async () => {
      const thumbnail = renderLightbox()
      fireEvent.click(thumbnail)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      await waitFor(() => expect(document.activeElement).toBe(thumbnail))
    })

    it('a close by the close button consumes the sentinel', async () => {
      const thumbnail = renderLightbox()
      fireEvent.click(thumbnail)
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Close image' }))

      await waitForSentinelDepth(0)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('a close by Esc consumes the sentinel', async () => {
      const thumbnail = renderLightbox()
      fireEvent.click(thumbnail)
      await waitForSentinelDepth(1)

      fireEvent.keyDown(document.body, { key: 'Escape' })

      await waitForSentinelDepth(0)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const thumbnail = renderLightbox()

      fireEvent.click(thumbnail)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
