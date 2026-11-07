import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TERMUL_TOOLS } from '@/lib/composer/termul-tools'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { ComposerAddMenu } from './ComposerAddMenu'
import type { ComposerAddHandle } from './ComposerAddSheet'
import type { ConnectorsHost } from './connectors-menu-model'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => undefined) }))

const servers = [
  { id: 'gh', name: 'GitHub', enabled: true },
  { id: 'mobbin', name: 'mobbin', enabled: false },
  { id: 'linear', name: 'Linear', enabled: true }
]

function makeHandle(): ComposerAddHandle {
  return {
    canPick: true,
    canPickImages: true,
    pickFiles: vi.fn(async () => undefined),
    insertTrigger: vi.fn(() => true),
    blurEditor: vi.fn(),
    focusEditor: vi.fn(),
    insertTool: vi.fn(() => true)
  }
}

function renderMenu(
  host: ConnectorsHost,
  overrides: Partial<React.ComponentProps<typeof ComposerAddMenu>['connectors']> = {}
) {
  const handle = makeHandle()
  const onToggle = vi.fn()
  const onReloadChat = vi.fn()
  render(
    <TooltipProvider>
      <ComposerAddMenu
        handle={handle}
        disabled={false}
        connectorsHost={host}
        termulTools={TERMUL_TOOLS.map((tool) => ({
          tool,
          state: tool.state({ canvasReady: false })
        }))}
        connectors={{
          count: 2,
          servers,
          onToggle,
          probeStatus: { linear: 'authRequired' },
          onReloadChat: host === 'launcher' ? undefined : onReloadChat,
          ...overrides
        }}
      />
    </TooltipProvider>
  )
  return { handle, onToggle, onReloadChat }
}

async function openMenu(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add to chat' }), {
    button: 0,
    ctrlKey: false
  })
  await screen.findByRole('menu')
}

async function openConnectors(): Promise<void> {
  await openMenu()
  const trigger = screen.getByRole('menuitem', { name: /Connectors/ })
  act(() => trigger.focus())
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })
  await screen.findByRole('menuitem', { name: 'Manage connectors' })
}

describe('ComposerAddMenu', () => {
  beforeEach(() => {
    useSettingsModalStore.setState({ view: null, appPage: null })
  })
  afterEach(() => cleanup())

  it('offers attach, mention, slash commands and connectors with the on count', async () => {
    renderMenu('chat-current')
    await openMenu()
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual([
      'Add files or photos',
      '@Mention@',
      '/Slash commands/',
      'Termul tools',
      'Connectors2 on'
    ])
  })

  it('lists the Termul tools, marks a closed canvas, and inserts the picked tool after closing', async () => {
    const { handle } = renderMenu('chat-current')
    await openMenu()
    const trigger = screen.getByRole('menuitem', { name: 'Termul tools' })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await screen.findByText('Ask the agent to use')
    const rows = screen
      .getAllByRole('menuitem')
      .filter(
        (item) =>
          item.closest('[data-radix-menu-content]') !== trigger.closest('[data-radix-menu-content]')
      )
      .map((item) => item.textContent)
    expect(rows).toEqual([
      'BrowserOpen, click and read pages',
      'CanvasDesign on the project canvasClosed',
      'AutomationsSchedule background work'
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Browser/ }))
    await waitFor(() => expect(handle.insertTool).toHaveBeenCalledWith('browser'))
  })

  it('inserts the @ trigger once the menu has closed', async () => {
    const { handle } = renderMenu('chat-current')
    let menuOpenAtInsert: boolean | null = null
    vi.mocked(handle.insertTrigger).mockImplementation(() => {
      menuOpenAtInsert = screen.queryByRole('menu') !== null
      return true
    })
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Mention/ }))
    await waitFor(() => expect(handle.insertTrigger).toHaveBeenCalledWith('@'))
    expect(menuOpenAtInsert).toBe(false)
    expect(handle.focusEditor).not.toHaveBeenCalled()
  })

  it('returns focus to the editor on Escape', async () => {
    const { handle } = renderMenu('chat-current')
    await openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(handle.focusEditor).toHaveBeenCalledOnce())
  })

  it('toggles a connector and keeps the menu open', async () => {
    const { onToggle } = renderMenu('chat-current')
    await openConnectors()
    const github = screen.getByRole('menuitemcheckbox', { name: 'GitHub' })
    expect(github).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'mobbin' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    fireEvent.click(github)
    expect(onToggle).toHaveBeenCalledWith('gh', false)
    expect(screen.getByRole('menuitemcheckbox', { name: 'GitHub' })).toBeInTheDocument()
  })

  it('offers sign-in for a server that needs it and keeps its toggle', async () => {
    const { onToggle } = renderMenu('chat-current')
    await openConnectors()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Linear' }))
    expect(onToggle).toHaveBeenCalledWith('linear', false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign in to Linear' }))
    expect(onToggle).toHaveBeenCalledOnce()
    expect(useSettingsModalStore.getState()).toMatchObject({
      view: 'app',
      appPage: 'mcp-servers'
    })
  })

  it('asks a chat with stale servers to reload, and only then', async () => {
    const { onReloadChat } = renderMenu('chat-stale')
    await openConnectors()
    expect(screen.getByText('This chat still uses the previous servers.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reload this chat' }))
    expect(onReloadChat).toHaveBeenCalledOnce()
    cleanup()

    renderMenu('chat-current')
    await openConnectors()
    expect(screen.queryByText('This chat still uses the previous servers.')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Reload this chat' })).toBeNull()
  })

  it('tells the launcher that a change applies to the next chat', async () => {
    renderMenu('launcher')
    await openConnectors()
    expect(screen.getByText('Takes effect on the next chat.')).toBeInTheDocument()
  })

  it('shows an empty registry with a way to add one', async () => {
    renderMenu('chat-current', { servers: [] })
    await openConnectors()
    expect(screen.getByText('No connectors yet')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Manage connectors' })).toBeInTheDocument()
    expect(screen.queryByText('This chat still uses the previous servers.')).toBeNull()
  })

  it('still offers the reload when the last connector of a stale chat was removed', async () => {
    const { onReloadChat } = renderMenu('chat-stale', { servers: [] })
    await openConnectors()
    expect(screen.getByText('No connectors yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reload this chat' }))
    expect(onReloadChat).toHaveBeenCalledOnce()
  })
})
