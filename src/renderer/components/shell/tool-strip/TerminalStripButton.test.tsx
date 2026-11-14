import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { TerminalStripButton } from './TerminalStripButton'

const { mockLog, mockGetShells } = vi.hoisted(() => ({
  mockLog: vi.fn(() => Promise.resolve()),
  mockGetShells: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))
vi.mock('@/lib/api', () => ({ shellApi: { getAvailableShells: mockGetShells } }))

const BASH = { path: '/bin/bash', name: 'bash', displayName: 'Bash' }
const ZSH = { path: '/bin/zsh', name: 'zsh', displayName: 'Zsh' }
const FISH = { path: '/usr/bin/fish', name: 'fish', displayName: 'Fish' }

async function renderButton(
  props: Partial<React.ComponentProps<typeof TerminalStripButton>> = {}
): Promise<ReturnType<typeof vi.fn>> {
  const onNewTerminal = vi.fn()
  render(
    <TooltipProvider>
      <TerminalStripButton disabled={false} onNewTerminal={onNewTerminal} {...props} />
    </TooltipProvider>
  )
  await waitFor(() => expect(mockGetShells).toHaveBeenCalled())
  await act(async () => {})
  return onNewTerminal
}

const button = () => screen.getByRole('button', { name: 'New terminal' })
const shellItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  mockGetShells.mockResolvedValue({
    success: true,
    data: { default: ZSH, available: [ZSH, BASH, FISH] }
  })
  useAppSettingsStore.setState((state) => ({
    settings: { ...state.settings, defaultShell: '' }
  }))
})

describe('TerminalStripButton', () => {
  it('opens a terminal with the default shell on a plain click, without a menu', async () => {
    const onNewTerminal = await renderButton()
    fireEvent.click(button())
    expect(onNewTerminal).toHaveBeenCalledWith()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[shell] strip opens a terminal tab' })
    )
  })

  it('lists the detected shells on right-click, the default first and marked', async () => {
    await renderButton()
    fireEvent.contextMenu(button())
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(shellItems()).toEqual(['ZshDefault', 'Bash', 'Fish'])
  })

  it('puts the project shell first when it is set (by file name)', async () => {
    await renderButton({ projectShell: 'fish' })
    fireEvent.contextMenu(button())
    await screen.findByRole('menu')
    expect(shellItems()).toEqual(['FishDefault', 'Bash', 'Zsh'])
  })

  it('opens a terminal with the picked shell and logs the pick', async () => {
    const onNewTerminal = await renderButton()
    fireEvent.contextMenu(button())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Bash' }))
    expect(onNewTerminal).toHaveBeenCalledWith(BASH)
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'Shell',
        message: '[shell] strip opens a terminal tab with shell bash'
      })
    )
  })

  it.each([
    { key: 'F10', shiftKey: true },
    { key: 'ContextMenu', shiftKey: false }
  ])('opens the shell menu with $key on the focused button', async (keys) => {
    const onNewTerminal = await renderButton()
    fireEvent.keyDown(button(), keys)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(onNewTerminal).not.toHaveBeenCalled()
  })

  it('says when no shell is detected', async () => {
    mockGetShells.mockResolvedValue({ success: true, data: { default: null, available: [] } })
    await renderButton()
    fireEvent.contextMenu(button())
    expect(await screen.findByRole('menuitem', { name: 'No shells detected' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('opens no menu while disabled', async () => {
    await renderButton({ disabled: true })
    fireEvent.contextMenu(button())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('tells about the other shells in its tooltip', async () => {
    await renderButton({ shortcut: 'Ctrl+T' })
    expect(button()).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.focus(button())
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('New terminal')
    expect(tooltip).toHaveTextContent('Right-click for other shells')
  })
})
