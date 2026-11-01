import type { IpcResult } from '@shared/types/ipc.types'
import type {
  McpCatalogIconUrl,
  McpCatalogPage,
  McpCatalogRow,
  McpCatalogSearchRequest,
  McpCatalogStatus
} from '@shared/types/mcp-catalog.types'
import type {
  McpInstallCommitResult,
  McpInstallFormReply,
  McpInstallPlanReply
} from '@shared/types/mcp-install.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acpApi } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { McpCatalogBrowser } from './McpCatalogBrowser'
import { SettingsLayout, SettingsSection } from './SettingsLayout'

const { search, status, setSync, icon, openUrl, install, admitsWrites } = vi.hoisted(() => ({
  search: vi.fn<(request: McpCatalogSearchRequest) => Promise<IpcResult<McpCatalogPage>>>(),
  status: vi.fn<() => Promise<IpcResult<McpCatalogStatus>>>(),
  setSync: vi.fn<(enabled: boolean) => Promise<IpcResult<McpCatalogStatus>>>(),
  icon: vi.fn<(name: string) => Promise<IpcResult<McpCatalogIconUrl>>>(),
  openUrl: vi.fn(async (_url: string) => ({ success: true as const, data: undefined })),
  install: {
    describeInstall: vi.fn<() => Promise<IpcResult<McpInstallFormReply>>>(),
    planInstall: vi.fn<() => Promise<IpcResult<McpInstallPlanReply>>>(),
    commitInstall: vi.fn<() => Promise<IpcResult<McpInstallCommitResult>>>(),
    cancelInstall: vi.fn(async () => ({ success: true as const, data: {} }))
  },
  admitsWrites: vi.fn(() => true)
}))

vi.mock('@/lib/mcp-catalog-api', () => ({
  mcpCatalogApi: { search, status, setSync, icon, ...install }
}))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: admitsWrites
}))
vi.mock('@/lib/acp-mcp-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-mcp-persistence')>()),
  saveMcpServers: vi.fn(async () => {})
}))
vi.mock('@/lib/api', () => ({ openerApi: { openUrlWithSystemBrowser: openUrl } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// jsdom has no layout, so the real virtualizer renders no rows. Render every
// row at a fixed height instead; the hook still runs for hook order.
vi.mock('@tanstack/react-virtual', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const real = actual.useVirtualizer(options)
      return {
        ...real,
        getTotalSize: () => options.count * 100,
        getVirtualItems: () =>
          Array.from({ length: options.count }, (_, index) => ({
            index,
            key: options.getItemKey?.(index) ?? index,
            start: index * 100,
            end: (index + 1) * 100,
            size: 100,
            lane: 0
          })),
        measureElement: () => {}
      }
    }
  }
})

const SNAPSHOT = new Date(2026, 9, 20, 12, 0).toISOString()
const SYNCED = new Date(2026, 9, 21, 9, 30).toISOString()

function row(overrides: Partial<McpCatalogRow> & Pick<McpCatalogRow, 'name'>): McpCatalogRow {
  return {
    title: null,
    description: 'A test server.',
    version: '1.0.0',
    status: 'active',
    state: 'installable',
    reason: null,
    defaultOption: { kind: 'remote', index: 0 },
    repositoryUrl: null,
    hasIcon: false,
    ...overrides
  }
}

const installable = row({
  name: 'io.example/weather',
  title: 'Weather Tools',
  repositoryUrl: 'https://github.com/example/weather'
})
const needsRuntime = row({
  name: 'io.example/pyserver',
  state: 'needs-runtime',
  reason: { code: 'needs-runtime', runtime: 'uvx' },
  defaultOption: { kind: 'package', index: 0 }
})
const unsupported = row({
  name: 'io.example/blocked',
  status: 'deprecated',
  state: 'unsupported',
  reason: { code: 'denied-env', name: 'NODE_OPTIONS' }
})
const sourceOnly = row({
  name: 'io.example/source',
  state: 'source-only',
  reason: { code: 'no-install-options' },
  defaultOption: null
})

function page(
  items: McpCatalogRow[],
  total = items.length,
  nextCursor: string | null = null,
  source: Pick<McpCatalogPage, 'updatedAt' | 'sample'> = { updatedAt: SNAPSHOT, sample: false }
): IpcResult<McpCatalogPage> {
  return { success: true, data: { items, total, nextCursor, ...source } }
}

function catalog(overrides: Partial<McpCatalogStatus> = {}): IpcResult<McpCatalogStatus> {
  return {
    success: true,
    data: {
      updatedAt: SNAPSHOT,
      sample: false,
      servers: 1,
      sync: { state: 'idle' },
      ...overrides
    }
  }
}

function syncSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Keep the catalog up to date' })
}

async function findRow(name: string): Promise<HTMLElement> {
  await screen.findByText(name)
  return rowOf(name)
}

function rowOf(name: string): HTMLElement {
  const element = screen.getByText(name).closest<HTMLElement>('[data-index]')
  if (!element) throw new Error(`no row for ${name}`)
  return element
}

beforeEach(() => {
  search.mockReset()
  status.mockReset()
  setSync.mockReset()
  icon.mockReset()
  openUrl.mockClear()
  vi.mocked(toast.error).mockClear()
  status.mockReturnValue(new Promise(() => {}))
  admitsWrites.mockReturnValue(true)
  useProjectStore.setState({ activeProjectId: 'p1' })
  useAcpStore.setState({ mcpServers: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('McpCatalogBrowser', () => {
  it('shows each state with its typed reason and installs only an installable server', async () => {
    search.mockResolvedValue(page([installable, needsRuntime, unsupported, sourceOnly]))
    render(<McpCatalogBrowser />)

    expect(await screen.findByText('4 servers')).toBeInTheDocument()

    const weather = within(rowOf('io.example/weather'))
    expect(weather.getByText('Weather Tools')).toBeInTheDocument()
    expect(weather.getByText('Installable')).toBeInTheDocument()

    const python = within(rowOf('io.example/pyserver'))
    expect(python.getByText('pyserver')).toBeInTheDocument()
    expect(python.getByText('Needs a runtime')).toBeInTheDocument()
    expect(python.getByText('Install uv (uvx) on this computer to run it.')).toBeInTheDocument()

    const blocked = within(rowOf('io.example/blocked'))
    expect(blocked.getByText('Unsupported')).toBeInTheDocument()
    expect(blocked.getByText('Deprecated')).toBeInTheDocument()
    expect(
      blocked.getByText(
        'It sets NODE_OPTIONS, an environment variable Termul blocks because it can change what runs.'
      )
    ).toBeInTheDocument()

    const source = within(rowOf('io.example/source'))
    expect(source.getByText('Source only')).toBeInTheDocument()
    expect(
      source.getByText(
        'The registry lists only its source code, with no package or hosted URL to install.'
      )
    ).toBeInTheDocument()

    const installs = screen.getAllByRole('button', { name: 'Install' })
    expect(installs.map((button) => (button as HTMLButtonElement).disabled)).toEqual([
      false,
      true,
      true,
      true
    ])
    expect(installs[1]).toHaveAccessibleDescription('Install uv (uvx) on this computer to run it.')
    expect(search.mock.calls).toEqual([[{ query: undefined, limit: 50 }]])
  })

  it('asks for the next page with the nextCursor of the last one', async () => {
    search
      .mockResolvedValueOnce(page([installable, needsRuntime], 3, '2'))
      .mockResolvedValueOnce(page([sourceOnly], 3, null))
    render(<McpCatalogBrowser />)

    expect(await screen.findByText('io.example/source')).toBeInTheDocument()
    expect(search.mock.calls).toEqual([
      [{ query: undefined, limit: 50 }],
      [{ query: undefined, cursor: '2', limit: 50 }]
    ])
    expect(screen.queryByText(/Showing/)).toBeNull()
  })

  it('searches the settled query and counts matches', async () => {
    search
      .mockResolvedValueOnce(page([installable, needsRuntime]))
      .mockResolvedValueOnce(page([installable]))
    render(<McpCatalogBrowser />)
    await screen.findByText('2 servers')

    fireEvent.change(screen.getByLabelText('Search the MCP catalog'), {
      target: { value: '  weather ' }
    })
    expect(screen.getByText('2 servers')).toBeInTheDocument()

    expect(await screen.findByText('1 match')).toBeInTheDocument()
    expect(search.mock.calls[1]).toEqual([{ query: 'weather', limit: 50 }])
    expect(screen.queryByText('io.example/pyserver')).toBeNull()
  })

  it('asks for fewer words instead of sending a query the host would reject', async () => {
    search.mockResolvedValue(page([installable]))
    render(<McpCatalogBrowser />)
    await screen.findByText('1 server')

    fireEvent.change(screen.getByLabelText('Search the MCP catalog'), {
      target: { value: 'one two three four five six seven eight nine' }
    })

    expect(await screen.findByText('Search with 8 words or fewer.')).toBeInTheDocument()
    expect(search.mock.calls).toEqual([[{ query: undefined, limit: 50 }]])
  })

  it('opens the repository link in the system browser', async () => {
    search.mockResolvedValue(page([installable]))
    render(<McpCatalogBrowser />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open the Weather Tools repository' })
    )

    expect(openUrl.mock.calls).toEqual([['https://github.com/example/weather']])
  })

  it('offers a retry when the search fails', async () => {
    search
      .mockResolvedValueOnce({ success: false, error: 'offline', code: 'NETWORK_ERROR' })
      .mockResolvedValueOnce(page([installable]))
    render(<McpCatalogBrowser />)

    expect(await screen.findByText("Termul couldn't load the MCP catalog.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('1 server')).toBeInTheDocument()
  })

  it('waits until its settings page is shown before searching', async () => {
    search.mockResolvedValue(page([installable]))
    const categories = [
      { id: 'appearance', label: 'Appearance' },
      { id: 'mcp-servers', label: 'MCP servers' }
    ]
    const { rerender } = render(
      <SettingsLayout title="Settings" categories={categories} searchIndex={[]} page="appearance">
        <SettingsSection id="mcp-servers">
          <McpCatalogBrowser />
        </SettingsSection>
      </SettingsLayout>
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(search.mock.calls).toEqual([])
    expect(status.mock.calls).toEqual([])

    rerender(
      <SettingsLayout title="Settings" categories={categories} searchIndex={[]} page="mcp-servers">
        <SettingsSection id="mcp-servers">
          <McpCatalogBrowser />
        </SettingsSection>
      </SettingsLayout>
    )

    await waitFor(() => expect(search.mock.calls).toEqual([[{ query: undefined, limit: 50 }]]))
    expect(status.mock.calls).toEqual([[]])
  })
})

describe('McpCatalogBrowser catalog source', () => {
  it('says the full catalog comes from the official MCP Registry and when it was updated', async () => {
    search.mockResolvedValue(page([installable]))
    status.mockResolvedValue(catalog())
    render(<McpCatalogBrowser />)

    expect(await screen.findByText('Up to date.')).toBeInTheDocument()
    expect(screen.getByText('Updated Oct 20, 2026, 12:00 PM.')).toBeInTheDocument()
    expect(screen.getByText(/^From the/)).toHaveTextContent('From the official MCP Registry')
    expect(screen.queryByText(/small sample/)).toBeNull()
    expect(syncSwitch()).toBeChecked()
  })

  it('says a sample catalog is the bundled sample and that sync loads the full one', async () => {
    search.mockResolvedValue(page([installable], 1, null, { updatedAt: SNAPSHOT, sample: true }))
    status.mockResolvedValue(catalog({ sample: true }))
    render(<McpCatalogBrowser />)

    expect(
      await screen.findByText(
        'This is the small sample bundled with this build, not the full registry. Sync replaces it with the full catalog.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Up to date.')).toBeNull()
  })

  it('says sync is off and that the sample stays until it is turned on', async () => {
    search.mockResolvedValue(page([installable], 1, null, { updatedAt: SNAPSHOT, sample: true }))
    status.mockResolvedValue(catalog({ sample: true, sync: { state: 'disabled' } }))
    render(<McpCatalogBrowser />)

    expect(
      await screen.findByText('Sync is off. No catalog request leaves this host.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'This is the small sample bundled with this build, not the full registry. Turn on sync to load the full catalog.'
      )
    ).toBeInTheDocument()
    expect(syncSwitch()).not.toBeChecked()
  })

  it('shows a full download in progress and an incremental check', async () => {
    search.mockResolvedValue(page([installable]))
    status.mockResolvedValueOnce(catalog({ sync: { state: 'syncing', full: true, fetched: 1200 } }))
    const { unmount } = render(<McpCatalogBrowser />)
    expect(
      await screen.findByText('Downloading the full registry… 1,200 servers so far.')
    ).toBeInTheDocument()
    unmount()

    status.mockResolvedValueOnce(catalog({ sync: { state: 'syncing', full: false, fetched: 3 } }))
    render(<McpCatalogBrowser />)
    expect(await screen.findByText('Checking for updates…')).toBeInTheDocument()
  })

  it('shows a failed sync with its error and retry time', async () => {
    search.mockResolvedValue(page([installable]))
    status.mockResolvedValue(
      catalog({
        sync: {
          state: 'failed',
          error: 'the registry answered 503.',
          retryAt: new Date(2026, 9, 20, 12, 5).toISOString()
        }
      })
    )
    render(<McpCatalogBrowser />)

    expect(
      await screen.findByText(
        'Sync failed: the registry answered 503. Retrying at Oct 20, 2026, 12:05 PM.'
      )
    ).toBeInTheDocument()
  })

  it('opens the official MCP Registry in the system browser', async () => {
    search.mockResolvedValue(page([installable]))
    status.mockResolvedValue(catalog())
    render(<McpCatalogBrowser />)

    fireEvent.click(await screen.findByRole('button', { name: 'official MCP Registry' }))

    expect(openUrl.mock.calls).toEqual([['https://registry.modelcontextprotocol.io']])
  })

  it('turns sync off, locking the switch until the host answers with the new status', async () => {
    search.mockResolvedValue(page([installable]))
    status.mockResolvedValue(catalog())
    let answer: (result: IpcResult<McpCatalogStatus>) => void = () => {}
    setSync.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    render(<McpCatalogBrowser />)
    await screen.findByText('Up to date.')

    fireEvent.click(syncSwitch())

    expect(setSync.mock.calls).toEqual([[false]])
    expect(syncSwitch()).not.toBeChecked()
    expect(syncSwitch()).toBeDisabled()

    await act(async () => answer(catalog({ sync: { state: 'disabled' } })))

    expect(
      screen.getByText('Sync is off. No catalog request leaves this host.')
    ).toBeInTheDocument()
    expect(syncSwitch()).not.toBeChecked()
    expect(syncSwitch()).toBeEnabled()
  })

  it('restores the switch and says only the host can change sync when refused', async () => {
    search.mockResolvedValue(page([installable]))
    status.mockResolvedValue(catalog())
    setSync.mockResolvedValueOnce({
      success: false,
      error: 'shared-live peers cannot change catalog sync',
      code: 'FORBIDDEN'
    })
    render(<McpCatalogBrowser />)
    await screen.findByText('Up to date.')

    fireEvent.click(syncSwitch())

    await waitFor(() => expect(syncSwitch()).toBeEnabled())
    expect(syncSwitch()).toBeChecked()
    expect(vi.mocked(toast.error).mock.calls).toEqual([['Only the host can change catalog sync.']])
  })

  it('shows the full download within one fast poll after sync is turned on over the sample', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    search.mockResolvedValue(page([installable], 22, null, { updatedAt: SNAPSHOT, sample: true }))
    status
      .mockResolvedValueOnce(catalog({ sample: true, servers: 22, sync: { state: 'disabled' } }))
      .mockResolvedValue(
        catalog({ sample: true, servers: 22, sync: { state: 'syncing', full: true, fetched: 300 } })
      )
    setSync.mockResolvedValue(catalog({ sample: true, servers: 22, sync: { state: 'idle' } }))
    render(<McpCatalogBrowser />)
    expect(
      await screen.findByText('Sync is off. No catalog request leaves this host.')
    ).toBeInTheDocument()

    fireEvent.click(syncSwitch())
    await waitFor(() => expect(syncSwitch()).not.toBeDisabled())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(
      screen.getByText('Downloading the full registry… 300 servers so far.')
    ).toBeInTheDocument()
  })

  it('searches again when a sync replaces the sample with the full registry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const full = Array.from({ length: 3 }, (_, index) => row({ name: `io.registry/s${index}` }))
    search
      .mockResolvedValueOnce(page([installable], 22, null, { updatedAt: SNAPSHOT, sample: true }))
      .mockResolvedValueOnce(page(full, 54_312, null, { updatedAt: SYNCED, sample: false }))
    status
      .mockResolvedValueOnce(
        catalog({ sample: true, servers: 22, sync: { state: 'syncing', full: true, fetched: 900 } })
      )
      .mockResolvedValue(catalog({ updatedAt: SYNCED, servers: 54_312 }))
    render(<McpCatalogBrowser />)
    expect(await screen.findByText('22 servers')).toBeInTheDocument()
    expect(
      screen.getByText('Downloading the full registry… 900 servers so far.')
    ).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(await screen.findByText('54,312 servers')).toBeInTheDocument()
    expect(screen.getByText('io.registry/s0')).toBeInTheDocument()
    expect(screen.getByText('Up to date.')).toBeInTheDocument()
    expect(search.mock.calls).toEqual([
      [{ query: undefined, limit: 50 }],
      [{ query: undefined, limit: 50 }]
    ])
  })
})

describe('McpCatalogBrowser logos', () => {
  const logoUrl: McpCatalogIconUrl = 'data:image/png;base64,iVBORw0KGgo='

  const withLogo = row({ name: 'io.example/logo', title: 'Logo Server', hasIcon: true })
  const withoutLogo = row({ name: 'io.example/plain', title: 'plain tools' })

  it('shows the host logo through an img and a lettered tile when there is none', async () => {
    icon.mockResolvedValue({ success: true, data: logoUrl })
    search.mockResolvedValue(page([withLogo, withoutLogo]))
    render(<McpCatalogBrowser />)

    const logoRow = await findRow('io.example/logo')
    await waitFor(() => expect(logoRow.querySelector('img')).not.toBeNull())
    const img = logoRow.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(img.getAttribute('width')).toBe('32')
    expect(img.alt).toBe('')
    expect(within(logoRow).queryByTestId('mcp-catalog-icon-placeholder')).toBeNull()

    const plainRow = await findRow('io.example/plain')
    expect(plainRow.querySelector('img')).toBeNull()
    expect(within(plainRow).getByTestId('mcp-catalog-icon-placeholder')).toHaveTextContent('P')
    expect(icon.mock.calls).toEqual([['io.example/logo']])
  })

  it('keeps the lettered tile when the host has no logo to give', async () => {
    icon.mockResolvedValue({
      success: false,
      error: 'the icon could not be loaded',
      code: 'MCP_CATALOG_ICON_UNAVAILABLE'
    })
    search.mockResolvedValue(page([withLogo]))
    render(<McpCatalogBrowser />)

    const logoRow = await findRow('io.example/logo')
    await waitFor(() => expect(icon).toHaveBeenCalledWith('io.example/logo'))
    expect(within(logoRow).getByTestId('mcp-catalog-icon-placeholder')).toHaveTextContent('L')
    expect(logoRow.querySelector('img')).toBeNull()
  })

  it('falls back to the lettered tile when the bytes do not decode', async () => {
    icon.mockResolvedValue({ success: true, data: 'data:image/png;base64,anVuaw==' })
    search.mockResolvedValue(page([withLogo]))
    render(<McpCatalogBrowser />)

    const logoRow = await findRow('io.example/logo')
    await waitFor(() => expect(logoRow.querySelector('img')).not.toBeNull())
    fireEvent.error(logoRow.querySelector('img') as HTMLImageElement)

    expect(within(logoRow).getByTestId('mcp-catalog-icon-placeholder')).toHaveTextContent('L')
    expect(logoRow.querySelector('img')).toBeNull()
  })

  it('names the tile after the registry name when there is no title', async () => {
    search.mockResolvedValue(page([row({ name: 'io.example/zeta-server' })]))
    render(<McpCatalogBrowser />)

    const zeta = await findRow('io.example/zeta-server')
    expect(within(zeta).getByTestId('mcp-catalog-icon-placeholder')).toHaveTextContent('Z')
    expect(icon).not.toHaveBeenCalled()
  })
})

describe('McpCatalogBrowser install', () => {
  it('disables every install with the reason on a view-only connection', async () => {
    admitsWrites.mockReturnValue(false)
    search.mockResolvedValue(page([installable]))
    render(<McpCatalogBrowser />)

    const button = await within(await findRow('io.example/weather')).findByRole('button', {
      name: 'Install'
    })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(
      "This connection can't make changes on the host, so it can't install servers."
    )
  })

  it('shows Installed for a server already installed from the catalog', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'w',
          type: 'http',
          name: 'weather-tools',
          url: 'https://weather.example/mcp',
          enabled: true,
          catalog: {
            source: 'mcp-registry',
            name: 'io.example/weather',
            version: '1.0.0',
            kind: 'remote',
            index: 0,
            repositoryId: null,
            launchDigest: 'd'
          }
        }
      ]
    })
    search.mockResolvedValue(page([installable, needsRuntime]))
    render(<McpCatalogBrowser />)

    const weather = within(await findRow('io.example/weather'))
    expect(weather.getByText('Installed')).toBeInTheDocument()
    expect(weather.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(
      within(rowOf('io.example/pyserver')).getByRole('button', { name: 'Install' })
    ).toBeDisabled()
  })

  it('installs a remote server through the form and the consent view', async () => {
    search.mockResolvedValue(page([installable]))
    const field = {
      id: 'key',
      label: 'API key',
      target: { kind: 'header', name: 'Authorization' },
      variable: 'key',
      isRequired: true,
      isSecret: true,
      format: 'string',
      choices: null,
      default: null,
      placeholder: null,
      description: null
    } as const
    const source = { kind: 'catalog', name: 'io.example/weather', version: '1.0.0' } as const
    const config = {
      transport: 'http',
      url: 'https://weather.example/mcp',
      headers: [{ name: 'Authorization', isSecret: true }]
    } as const
    install.describeInstall.mockResolvedValue({
      success: true,
      data: {
        outcome: 'form',
        form: {
          source,
          choice: { kind: 'remote', index: 0 },
          title: 'Weather Tools',
          fields: [field]
        }
      }
    })
    install.planInstall.mockResolvedValue({
      success: true,
      data: {
        outcome: 'plan',
        plan: {
          planId: 'p-1',
          name: 'weather-tools',
          source,
          choice: { kind: 'remote', index: 0 },
          expiresAt: '2026-11-01T00:10:00Z',
          config,
          form: [field],
          consentView: {
            transport: 'http',
            command: null,
            argv: [],
            url: 'https://weather.example/mcp',
            env: [],
            headers: [
              { name: 'Authorization', value: 'Bearer {key}', isSecret: true, origin: 'registry' }
            ],
            hostMounts: [],
            warnings: ['sends-data-remote'],
            provenance: null
          },
          launchDigest: 'digest-1'
        }
      }
    })
    install.commitInstall.mockResolvedValue({
      success: true,
      data: {
        name: 'weather-tools',
        config,
        secrets: [{ slot: 'header', name: 'Authorization', value: 'Bearer sk-1' }],
        provenance: {
          name: 'io.example/weather',
          version: '1.0.0',
          kind: 'remote',
          index: 0,
          repositoryId: null
        },
        launchDigest: 'digest-1'
      }
    })
    vi.spyOn(acpApi, 'probeMcpServer').mockResolvedValue({
      status: 'connected',
      tools: [{ name: 'forecast' }]
    })
    render(<McpCatalogBrowser />)

    fireEvent.click(
      within(await findRow('io.example/weather')).getByRole('button', { name: 'Install' })
    )
    fireEvent.change(await screen.findByLabelText('API key*'), { target: { value: 'sk-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(await screen.findByText('https://weather.example/mcp')).toBeInTheDocument()
    expect(screen.getByText('Bearer {key}')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('It responds and offers 1 tool.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Installed weather-tools' })).toBeInTheDocument()
    expect(install.commitInstall.mock.calls).toEqual([
      [{ planId: 'p-1', launchDigest: 'digest-1', secretValues: { key: 'sk-1' } }]
    ])
    expect(useAcpStore.getState().mcpServers.map((server) => server.name)).toEqual([
      'weather-tools'
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(within(rowOf('io.example/weather')).getByText('Installed')).toBeInTheDocument()
    )
  })
})
