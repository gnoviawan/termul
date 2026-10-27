import type { IpcResult } from '@shared/types/ipc.types'
import type {
  McpCatalogPage,
  McpCatalogRow,
  McpCatalogSearchRequest
} from '@shared/types/mcp-catalog.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpCatalogBrowser } from './McpCatalogBrowser'
import { SettingsLayout, SettingsSection } from './SettingsLayout'

const { search, openUrl } = vi.hoisted(() => ({
  search: vi.fn<(request: McpCatalogSearchRequest) => Promise<IpcResult<McpCatalogPage>>>(),
  openUrl: vi.fn(async (_url: string) => ({ success: true as const, data: undefined }))
}))

vi.mock('@/lib/mcp-catalog-api', () => ({ mcpCatalogApi: { search } }))
vi.mock('@/lib/api', () => ({ openerApi: { openUrlWithSystemBrowser: openUrl } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

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

const SNAPSHOT = '2026-10-20T12:00:00Z'

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

function page(items: McpCatalogRow[], total = items.length, nextCursor: string | null = null) {
  return {
    success: true as const,
    data: { items, total, nextCursor, snapshotFetchedAt: SNAPSHOT }
  }
}

function rowOf(name: string): HTMLElement {
  const element = screen.getByText(name).closest<HTMLElement>('[data-index]')
  if (!element) throw new Error(`no row for ${name}`)
  return element
}

beforeEach(() => {
  search.mockReset()
  openUrl.mockClear()
})

describe('McpCatalogBrowser', () => {
  it('shows each state with its typed reason and a disabled install button', async () => {
    search.mockResolvedValue(page([installable, needsRuntime, unsupported, sourceOnly]))
    render(<McpCatalogBrowser />)

    expect(await screen.findByText('4 servers · catalog from Oct 20, 2026')).toBeInTheDocument()

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
      true,
      true,
      true,
      true
    ])
    expect(installs[0]).toHaveAccessibleDescription(
      'Installing from the catalog is coming soon. Until then, add servers by hand in the list above.'
    )
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
    await screen.findByText('2 servers · catalog from Oct 20, 2026')

    fireEvent.change(screen.getByLabelText('Search the MCP catalog'), {
      target: { value: '  weather ' }
    })
    expect(screen.getByText('2 servers · catalog from Oct 20, 2026')).toBeInTheDocument()

    expect(await screen.findByText('1 match · catalog from Oct 20, 2026')).toBeInTheDocument()
    expect(search.mock.calls[1]).toEqual([{ query: 'weather', limit: 50 }])
    expect(screen.queryByText('io.example/pyserver')).toBeNull()
  })

  it('asks for fewer words instead of sending a query the host would reject', async () => {
    search.mockResolvedValue(page([installable]))
    render(<McpCatalogBrowser />)
    await screen.findByText('1 server · catalog from Oct 20, 2026')

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

    expect(await screen.findByText('1 server · catalog from Oct 20, 2026')).toBeInTheDocument()
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

    rerender(
      <SettingsLayout title="Settings" categories={categories} searchIndex={[]} page="mcp-servers">
        <SettingsSection id="mcp-servers">
          <McpCatalogBrowser />
        </SettingsSection>
      </SettingsLayout>
    )

    await waitFor(() => expect(search.mock.calls).toEqual([[{ query: undefined, limit: 50 }]]))
  })
})
