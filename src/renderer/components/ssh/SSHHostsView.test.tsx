import type { SSHProfile } from '@shared/types/ssh.types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type SSHSession, useSSHStore } from '@/stores/ssh-store'
import type { SSHHostActions } from './SSHHostRow'
import { groupHosts, matchesHostQuery, SSHHostsView } from './SSHHostsView'

const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true } }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => tauriRef.current
}))

function host(id: string, overrides: Partial<SSHProfile> = {}): SSHProfile {
  return {
    id,
    name: id,
    host: `${id}.example`,
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    portForwards: [],
    ...overrides
  }
}

const profiles = [
  host('web', { group: 'Production', tags: ['nginx'] }),
  host('db', { group: 'Production' }),
  host('lab'),
  host('bastion', { favorite: true, group: 'Production' })
]

function actions(): SSHHostActions {
  return {
    connect: vi.fn(),
    edit: vi.fn(),
    duplicate: vi.fn(),
    toggleFavorite: vi.fn(),
    remove: vi.fn()
  }
}

function renderView(overrides: Partial<React.ComponentProps<typeof SSHHostsView>> = {}) {
  const props = {
    profiles,
    sessions: [] as SSHSession[],
    selectedProfileId: null,
    actions: actions(),
    onNewHost: vi.fn(),
    onImport: vi.fn(),
    ...overrides
  }
  render(<SSHHostsView {...props} />)
  return props
}

beforeEach(() => {
  tauriRef.current = true
  useSSHStore.setState({ showAddresses: false })
})

describe('groupHosts', () => {
  it('puts favorites first, then groups, then the rest, each sorted', () => {
    expect(groupHosts(profiles).map((s) => [s.title, s.hosts.map((h) => h.id)])).toEqual([
      ['Favorites', ['bastion']],
      ['Production', ['db', 'web']],
      ['Other hosts', ['lab']]
    ])
  })

  it('calls a lone ungrouped section "All hosts"', () => {
    expect(groupHosts([host('a')]).map((s) => s.title)).toEqual(['All hosts'])
  })
})

describe('matchesHostQuery', () => {
  it('matches name, address, user@host, group and tags', () => {
    const web = profiles[0]
    for (const q of ['WEB', 'web.example', 'deploy@web', 'product', 'nginx', '']) {
      expect(matchesHostQuery(web, q), q).toBe(true)
    }
    expect(matchesHostQuery(web, 'mysql')).toBe(false)
  })
})

describe('SSHHostsView', () => {
  it('renders labelled sections with counts', () => {
    renderView()
    const production = screen.getByRole('region', { name: /Production/ })
    expect(within(production).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Favorites 1' })).toBeInTheDocument()
  })

  it('filters as you type and offers to clear when nothing matches', () => {
    renderView()
    const search = screen.getByRole('searchbox', { name: 'Search hosts' })
    fireEvent.change(search, { target: { value: 'nginx' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('No hosts match “zzz”.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show all hosts' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('"/" focuses the search box and Esc clears it', () => {
    renderView()
    fireEvent.keyDown(document.body, { key: '/' })
    const search = screen.getByRole('searchbox', { name: 'Search hosts' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'db' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
  })

  it('connects on click and moves between hosts with the arrow keys', () => {
    const props = renderView()
    const buttons = screen.getAllByRole('button', { name: /^Connect to / })
    fireEvent.click(buttons[0])
    expect(props.actions.connect).toHaveBeenCalledWith(profiles[3])
    buttons[0].focus()
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[1])
  })

  it('shows session state and count per host', () => {
    const session = (id: string, status: SSHSession['status']) =>
      ({ id, profileId: 'web', status }) as SSHSession
    renderView({ sessions: [session('a', 'connected'), session('b', 'failed')] })
    expect(
      screen.getByRole('button', { name: /Connect to web, .*Connected · 2 sessions/ })
    ).toBeInTheDocument()
  })

  it('hides usernames and addresses until shown, and can hide them again', () => {
    renderView()
    const toggle = screen.getByRole('button', { name: 'Show addresses' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('deploy@web.example')).toBeNull()
    expect(
      screen.getByRole('button', { name: /^Connect to web/ }).getAttribute('aria-label')
    ).not.toContain('web.example')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('deploy@web.example')).toBeInTheDocument()
    expect(useSSHStore.getState().showAddresses).toBe(true)

    fireEvent.click(toggle)
    expect(screen.queryByText('deploy@web.example')).toBeNull()
  })

  it('edits from the row', () => {
    const props = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Edit lab' }))
    expect(props.actions.edit).toHaveBeenCalledWith(profiles[2])
  })

  it('opens the editor instead of connecting on the web client', () => {
    tauriRef.current = false
    const props = renderView()
    expect(
      screen.getByText(/Connecting to them works in the Termul desktop app/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Edit lab,/ }))
    expect(props.actions.edit).toHaveBeenCalledWith(profiles[2])
    expect(props.actions.connect).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
  })

  it('guides the first run with New host and Import', () => {
    const props = renderView({ profiles: [] })
    expect(screen.getByRole('heading', { name: 'No hosts yet' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New host' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import ~/.ssh/config' }))
    expect(props.onNewHost).toHaveBeenCalled()
    expect(props.onImport).toHaveBeenCalled()
  })
})
