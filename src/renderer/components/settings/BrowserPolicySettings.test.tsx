import {
  APP_PREAPPROVABLE_ACTIONS,
  PROJECT_PREAPPROVABLE_ACTIONS
} from '@shared/types/browser-policy.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishBrowserPolicyChange } from '@/lib/browser-policy-api'
import {
  type BrowserPolicyHost,
  createBrowserPolicyHost,
  DESKTOP_COMMANDS
} from '@/lib/test-utils/browser-policy-host'
import { BrowserAppPolicy, BrowserProjectPolicy } from './BrowserPolicySettings'

const { invokeIpc } = vi.hoisted(() => ({ invokeIpc: vi.fn() }))

vi.mock('@/lib/ipc/tauri', () => ({ invokeIpc }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => true }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

let host: BrowserPolicyHost

function BrowserPolicySettings(): React.JSX.Element {
  return (
    <>
      <BrowserProjectPolicy projectId="p1" />
      <BrowserAppPolicy />
    </>
  )
}

function connect(): void {
  host = createBrowserPolicyHost()
  invokeIpc.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    host.dispatch(DESKTOP_COMMANDS[command], args)
  )
}

function addOrigin(origin: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Allowed sites' }), {
    target: { value: origin }
  })
  const form = screen
    .getByRole('textbox', { name: 'Allowed sites' })
    .closest('form') as HTMLFormElement
  fireEvent.click(within(form).getByRole('button', { name: /add/i }))
}

describe('BrowserPolicySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connect()
  })

  it('shows the active project rules and the app-wide rules from the host', async () => {
    host.dispatch('apply_project', {
      projectId: 'p1',
      expectedRevision: 0,
      op: { op: 'add_origin', origin: 'https://docs.example' }
    })
    render(<BrowserPolicySettings />)

    expect(await screen.findByText('https://docs.example')).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'Browse logged out in this project' })
    ).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Shared agent profile' })).toBeChecked()
    expect(invokeIpc).toHaveBeenCalledWith('browser_policy_get_project', { projectId: 'p1' })
    expect(invokeIpc).toHaveBeenCalledWith('browser_policy_get_app')
  })

  it('adds and removes an allowed site through the host', async () => {
    render(<BrowserPolicySettings />)
    await screen.findByRole('textbox', { name: 'Allowed sites' })

    addOrigin('https://*.example.org')
    expect(await screen.findByText('https://*.example.org')).toBeInTheDocument()
    expect(host.projects.get('p1')?.allowList).toEqual(['https://*.example.org'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove https://*.example.org' }))
    await waitFor(() => expect(screen.queryByText('https://*.example.org')).not.toBeInTheDocument())
    expect(host.projects.get('p1')?.allowList).toEqual([])
  })

  it('explains a refused origin in plain words and keeps the draft', async () => {
    render(<BrowserPolicySettings />)
    await screen.findByRole('textbox', { name: 'Allowed sites' })

    addOrigin('not a url')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an http or https address such as https://example.com.'
    )
    expect(screen.getByRole('textbox', { name: 'Allowed sites' })).toHaveValue('not a url')

    addOrigin('http://tauri.localhost')
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        "Termul's own addresses and local-only addresses can't be allowed."
      )
    )
    expect(host.projects.get('p1')?.allowList).toEqual([])
  })

  it('toggles ephemeral browsing and the shared profile', async () => {
    render(<BrowserPolicySettings />)
    const ephemeral = await screen.findByRole('switch', {
      name: 'Browse logged out in this project'
    })
    fireEvent.click(ephemeral)
    await waitFor(() => expect(ephemeral).toBeChecked())
    expect(host.projects.get('p1')?.profileMode).toBe('ephemeral')

    const shared = screen.getByRole('switch', { name: 'Shared agent profile' })
    fireEvent.click(shared)
    await waitFor(() => expect(shared).not.toBeChecked())
    expect(host.app.globalProfileEnabled).toBe(false)
  })

  it('asks before password submits only once the user turns it on', async () => {
    render(<BrowserPolicySettings />)
    const ask = await screen.findByRole('switch', {
      name: 'Ask before an agent submits a password'
    })
    expect(ask).not.toBeChecked()
    fireEvent.click(ask)
    await waitFor(() => expect(ask).toBeChecked())
    expect(host.app.askBeforePasswordSubmit).toBe(true)
  })

  it('says when agents browse logged out although the shared profile is requested', async () => {
    host.engineKeepsGlobal = false
    render(<BrowserPolicySettings />)
    expect(
      await screen.findByText(/This system cannot keep a shared agent profile/)
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Agents browse logged out in this project for now/)
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Shared agent profile' })).toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'Browse logged out in this project' })
    ).not.toBeChecked()
  })

  it('shows no fallback note while agents get the profile they asked for', async () => {
    render(<BrowserPolicySettings />)
    await screen.findByRole('switch', { name: 'Shared agent profile' })
    expect(screen.queryByText(/This system cannot keep a shared agent profile/)).toBeNull()
    expect(screen.queryByText(/Agents browse logged out in this project for now/)).toBeNull()
  })

  it('lists a pre-approval added from the project form', async () => {
    render(<BrowserPolicySettings />)
    const list = await screen.findByRole('textbox', { name: 'Pre-approved actions' })
    const form = list.closest('form') as HTMLFormElement
    fireEvent.change(list, { target: { value: 'https://files.example' } })
    fireEvent.click(within(form).getByRole('button', { name: /add/i }))

    expect(await screen.findByText('https://files.example')).toBeInTheDocument()
    expect(host.projects.get('p1')?.preapprovals).toEqual([
      { action: 'password_submit', origin: 'https://files.example' }
    ])
  })

  it('offers only actions each scope may pre-approve', () => {
    expect(APP_PREAPPROVABLE_ACTIONS).toContain('password_submit')
    expect(APP_PREAPPROVABLE_ACTIONS).not.toContain('payment_submit')
    expect(PROJECT_PREAPPROVABLE_ACTIONS).toEqual(
      expect.arrayContaining(['password_submit', 'payment_submit', 'upload', 'download'])
    )
    for (const action of ['navigate', 'local_network']) {
      expect(PROJECT_PREAPPROVABLE_ACTIONS).not.toContain(action)
      expect(APP_PREAPPROVABLE_ACTIONS).not.toContain(action)
    }
  })

  it('confirms before clearing the agent profile and says what closes', async () => {
    host.app.clearImpact = { sessions: 3, projects: 2 }
    host.clearOutcome = 'ok'
    render(<BrowserPolicySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear agent profile' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('3 chats in 2 projects lose their agent browser tabs')
    expect(host.cleared).toBe(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear profile' }))
    await waitFor(() => expect(host.cleared).toBe(1))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('says only the shared profile is affected when no tab uses it', async () => {
    host.app.clearImpact = { sessions: 0, projects: 0 }
    render(<BrowserPolicySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear agent profile' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('No tabs on the shared agent profile are open right now.')
    expect(dialog).not.toHaveTextContent('No agent browser tabs')
  })

  it('reports that this build cannot clear the profile yet', async () => {
    render(<BrowserPolicySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear agent profile' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear profile' }))

    expect(
      await screen.findByText("This build can't clear the agent browser profile yet.")
    ).toBeInTheDocument()
  })

  it('shows rules written by a newer termul as read-only', async () => {
    const policy = host.dispatch('get_project', { projectId: 'p1' })
    expect(policy.success).toBe(true)
    host.projects.get('p1')!.readOnly = true
    host.projects.get('p1')!.allowList = ['https://kept.example']
    render(<BrowserPolicySettings />)

    expect(await screen.findByText('https://kept.example')).toBeInTheDocument()
    expect(screen.getByText(/saved by a newer version of Termul/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Allowed sites' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove https://kept.example' })).toBeDisabled()
  })

  it('re-reads a scope when the host announces a change from another surface', async () => {
    render(<BrowserPolicySettings />)
    await screen.findByRole('textbox', { name: 'Allowed sites' })

    host.dispatch('apply_project', {
      projectId: 'p1',
      expectedRevision: 0,
      op: { op: 'add_origin', origin: 'https://remote.example' }
    })
    act(() => publishBrowserPolicyChange({ scope: 'project', projectId: 'p1', revision: 1 }))
    expect(await screen.findByText('https://remote.example')).toBeInTheDocument()

    host.dispatch('apply_app', {
      expectedRevision: 0,
      op: { op: 'set_global_profile', enabled: false }
    })
    act(() => publishBrowserPolicyChange({ scope: 'app', revision: 1 }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Shared agent profile' })).not.toBeChecked()
    )
  })

  it('says so when the host has no browser policy', async () => {
    invokeIpc.mockImplementation(async () => ({
      success: false,
      code: 'capability_unavailable',
      error: 'policy_store_unavailable: browser policy is not available on this host'
    }))
    render(<BrowserPolicySettings />)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts[0]).toHaveTextContent("Browser rules aren't available on this host.")
  })

  it('tells a project-bound client that app rules need app scope', async () => {
    invokeIpc.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
      command === 'browser_policy_get_app'
        ? {
            success: false,
            code: 'invalid_params',
            error: 'app_scope_required: app-level browser policy needs a client with app scope'
          }
        : host.dispatch(DESKTOP_COMMANDS[command], args)
    )
    render(<BrowserPolicySettings />)
    expect(
      await screen.findByText('This device can only change the rules for its own project.')
    ).toBeInTheDocument()
    expect(await screen.findByRole('textbox', { name: 'Allowed sites' })).toBeEnabled()
  })
})
