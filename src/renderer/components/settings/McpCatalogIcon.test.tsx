import type { McpCatalogApi } from '@shared/types/mcp-catalog.types'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpCatalogIcon } from './McpCatalogIcon'

const { carrier, transport, fetchMock } = vi.hoisted(() => ({
  carrier: { kind: 'web' as 'web' | 'desktop' },
  transport: { getMcpCatalogIcon: vi.fn() },
  fetchMock: vi.fn()
}))

vi.mock('@/lib/acp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/acp-transport')>()),
  getAcpTransport: () => transport
}))

vi.mock('@/lib/mcp-catalog-api', async () => {
  const { webMcpCatalogApi } = await import('@/lib/web-mcp-catalog-api')
  const { createDesktopMcpCatalogApi } = await import('@/lib/desktop-mcp-catalog-api')
  const desktop = createDesktopMcpCatalogApi()
  const mcpCatalogApi: Pick<McpCatalogApi, 'icon'> = {
    icon: (name) => (carrier.kind === 'desktop' ? desktop : webMcpCatalogApi).icon(name)
  }
  return { mcpCatalogApi }
})

const SVG_WITH_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>localStorage.clear()</script></svg>'
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const logos = [
  {
    type: 'image/svg+xml',
    bytes: new TextEncoder().encode(SVG_WITH_SCRIPT),
    base64:
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+bG9jYWxTdG9yYWdlLmNsZWFyKCk8L3NjcmlwdD48L3N2Zz4='
  },
  { type: 'image/png', bytes: PNG_SIGNATURE, base64: 'iVBORw0KGgo=' }
]

describe('McpCatalogIcon', () => {
  beforeEach(() => {
    transport.getMcpCatalogIcon.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/app-origin')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  for (const kind of ['web', 'desktop'] as const) {
    for (const logo of logos) {
      it(`renders a ${logo.type} logo from the ${kind} carrier as a data: URL, never a blob: URL`, async () => {
        carrier.kind = kind
        transport.getMcpCatalogIcon.mockResolvedValue({
          contentType: logo.type,
          base64: logo.base64
        })
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          blob: async () => new Blob([logo.bytes], { type: logo.type })
        })

        const { container } = render(
          <McpCatalogIcon name="io.example/logo" displayName="Logo" hasIcon />
        )

        await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
          `data:${logo.type};base64,${logo.base64}`
        )
        expect(URL.createObjectURL).not.toHaveBeenCalled()
      })
    }
  }
})
