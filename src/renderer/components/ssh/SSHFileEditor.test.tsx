import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { useSSHStore } from '@/stores/ssh-store'
import { SSHFileEditor } from './SSHFileEditor'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/api', () => ({
  sshApi: { sftpWriteFile: vi.fn().mockResolvedValue({ success: true }) }
}))

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

function seedFile(dirty: boolean): void {
  useSSHStore.setState({
    editingFile: {
      path: '/srv/app/notes.txt',
      name: 'notes.txt',
      content: 'original',
      originalContent: 'original'
    },
    editingContent: dirty ? 'original, edited' : 'original'
  })
}

/** The editor's Close button asks to confirm only while the file is dirty. */
function pressClose(): void {
  fireEvent.click(screen.getByTitle('Close'))
}

describe('SSHFileEditor unsaved-changes confirm and the overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    useSSHStore.setState({ editingFile: null, editingContent: '' })
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    useSSHStore.setState({ editingFile: null, editingContent: '' })
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers only the confirm: system back takes Continue Editing once, the file stays dirty and open', async () => {
      seedFile(true)
      render(<SSHFileEditor connectionId="conn-1" />)

      // The editor body is not an overlay.
      await settleOverlayBackStack()
      expect(stackIds()).toEqual([])
      expect(readOverlaySentinelDepth(history.state)).toBe(0)

      pressClose()
      expect(screen.getByText('Unsaved Changes')).toBeInTheDocument()
      expect(stackIds()).toHaveLength(1)
      expect(stackIds()[0]).toMatch(/^ssh-unsaved-changes-confirm:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument())
      // Nothing was saved or discarded.
      const { editingFile, editingContent } = useSSHStore.getState()
      expect(editingFile?.name).toBe('notes.txt')
      expect(editingContent).toBe('original, edited')
      expect(editingFile?.originalContent).toBe('original')
      expect(screen.getByTitle('Close')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by Continue Editing consumes the sentinel', async () => {
      seedFile(true)
      render(<SSHFileEditor connectionId="conn-1" />)
      pressClose()
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Continue Editing' }))

      await waitForSentinelDepth(0)
      expect(stackIds()).toEqual([])
      expect(useSSHStore.getState().editingFile).not.toBeNull()
    })

    it('unregisters when Discard closes the file', async () => {
      seedFile(true)
      render(<SSHFileEditor connectionId="conn-1" />)
      pressClose()
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

      await waitForSentinelDepth(0)
      expect(stackIds()).toEqual([])
      expect(useSSHStore.getState().editingFile).toBeNull()
    })

    it('is not registered when the file is clean (Close just closes the file)', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      seedFile(false)
      render(<SSHFileEditor connectionId="conn-1" />)

      pressClose()
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
      expect(useSSHStore.getState().editingFile).toBeNull()
    })

    it('is not registered with no file being edited', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      render(<SSHFileEditor connectionId="conn-1" />)
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
    })

    it('unregisters when the file goes away while the confirm is up', async () => {
      seedFile(true)
      render(<SSHFileEditor connectionId="conn-1" />)
      pressClose()
      await waitForSentinelDepth(1)

      act(() => useSSHStore.setState({ editingFile: null }))

      await waitForSentinelDepth(0)
      expect(stackIds()).toEqual([])
    })
  })

  describe('desktop shell', () => {
    it('is inert: the confirm registers nothing and no history call is made', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      seedFile(true)
      render(<SSHFileEditor connectionId="conn-1" />)

      pressClose()
      expect(screen.getByText('Unsaved Changes')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Continue Editing' }))
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
