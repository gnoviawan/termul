import { describe, expect, it } from 'vitest'
import { mcpCatalogReasonText, mcpCatalogSyncText } from './mcp-catalog-copy'

describe('mcpCatalogReasonText', () => {
  it('names the runtime a needs-runtime row has to install', () => {
    expect(
      (['npx', 'uvx', 'docker', 'dotnet'] as const).map((runtime) =>
        mcpCatalogReasonText({ code: 'needs-runtime', runtime })
      )
    ).toEqual([
      'Install Node.js (npx) on this computer to run it.',
      'Install uv (uvx) on this computer to run it.',
      'Install Docker on this computer to run it.',
      'Install .NET SDK 10 or newer on this computer to run it.'
    ])
  })

  it('names the package host Termul does not download from', () => {
    expect(
      mcpCatalogReasonText({ code: 'unsupported-registry', registry: 'ghcr.example.com' })
    ).toBe("Its package is hosted on ghcr.example.com, which Termul doesn't download from.")
  })
})

describe('mcpCatalogSyncText', () => {
  it('gives only the time of a retry later today', () => {
    const now = new Date(2026, 9, 20, 12, 0)
    const text = mcpCatalogSyncText(
      {
        updatedAt: null,
        sample: false,
        servers: 0,
        sync: {
          state: 'failed',
          error: 'connection refused',
          retryAt: new Date(2026, 9, 20, 12, 5).toISOString()
        }
      },
      now
    )
    expect(text?.replace(/\s/g, ' ')).toBe('Sync failed: connection refused. Retrying at 12:05 PM.')
  })
})
