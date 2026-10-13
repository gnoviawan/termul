import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import { SSHPopover } from './SSHPopover'

const { tauriRef, panelRef } = vi.hoisted(() => ({
  tauriRef: { current: true },
  panelRef: { current: null as Record<string, unknown> | null }
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => tauriRef.current }))

interface PanelStubProps {
  onConnect?: (id: string) => void
  dialogs: {
    openForm: (profile: unknown) => void
    requestDelete: (profile: unknown) => void
  }
}

// The panel itself is covered by SSHPanel.test; here we drive its dialog requests.
vi.mock('@/components/ssh/SSHPanel', () => ({
  SSHPanel: (props: PanelStubProps) => {
    panelRef.current = props as unknown as Record<string, unknown>
    return (
      <div data-testid="ssh-panel">
        <button type="button" onClick={() => props.onConnect?.('h1')}>
          connect-h1
        </button>
        <button type="button" onClick={() => props.dialogs.openForm({ id: 'h1', name: 'Host 1' })}>
          edit-h1
        </button>
        <button
          type="button"
          onClick={() => props.dialogs.requestDelete({ id: 'h1', name: 'Host 1' })}
        >
          delete-h1
        </button>
      </div>
    )
  }
}))
vi.mock('@/components/ssh/SSHHostEditor', () => ({
  SSHHostEditor: ({
    open,
    onOpenChange
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div role="dialog" aria-label="profile form">
        <button type="button" onClick={() => onOpenChange(false)}>
          close-form
        </button>
      </div>
    ) : null
}))
vi.mock('@/stores/ssh-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSSHActions: () => ({
    loadProfiles: vi.fn(),
    deleteProfile: vi.fn(),
    selectProfile: vi.fn()
  })
}))

function Occluded(): React.JSX.Element {
  return <span data-testid="occluded">{String(useNativeWebviewOccluded())}</span>
}

function renderPopover(props: Partial<React.ComponentProps<typeof SSHPopover>> = {}) {
  return render(
    <>
      <SSHPopover {...props} />
      <Occluded />
    </>
  )
}

function openPopover(): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'SSH hosts' })
  fireEvent.click(trigger)
  return trigger
}

describe('SSHPopover', () => {
  beforeEach(() => {
    tauriRef.current = true
    panelRef.current = null
  })

  afterEach(() => {
    cleanup()
    resetNativeWebviewOcclusionForTests()
  })

  it('renders nothing on web', () => {
    tauriRef.current = false
    const { container } = renderPopover()
    expect(container.querySelector('button')).toBeNull()
  })

  it('opens a popover with the SSH panel and occludes native webviews while open', async () => {
    renderPopover()
    expect(screen.queryByTestId('ssh-panel')).toBeNull()
    openPopover()
    expect(await screen.findByTestId('ssh-panel')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('occluded').textContent).toBe('true'))
    expect(panelRef.current?.focusableRows).toBe(true)
  })

  it('hands connect to the same handler as the section', async () => {
    const onSSHConnect = vi.fn()
    renderPopover({ onSSHConnect })
    openPopover()
    fireEvent.click(await screen.findByText('connect-h1'))
    expect(onSSHConnect).toHaveBeenCalledWith('h1')
  })

  it('closes the popover first, then opens the form, and returns focus to the icon', async () => {
    renderPopover()
    const trigger = openPopover()
    fireEvent.click(await screen.findByText('edit-h1'))
    await waitFor(() => expect(screen.queryByTestId('ssh-panel')).toBeNull())
    const dialog = await screen.findByRole('dialog', { name: 'profile form' })
    fireEvent.click(screen.getByText('close-form'))
    expect(dialog.isConnected).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('closes the popover first for delete and returns focus when the confirm is cancelled', async () => {
    renderPopover()
    const trigger = openPopover()
    fireEvent.click(await screen.findByText('delete-h1'))
    await waitFor(() => expect(screen.queryByTestId('ssh-panel')).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('Esc closes the popover and focus returns to the icon', async () => {
    renderPopover()
    const trigger = openPopover()
    await screen.findByTestId('ssh-panel')
    fireEvent.keyDown(screen.getByTestId('ssh-panel'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('ssh-panel')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
