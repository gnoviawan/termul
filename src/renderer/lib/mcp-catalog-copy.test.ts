import { describe, expect, it } from 'vitest'
import { mcpCatalogReasonText } from './mcp-catalog-copy'

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

  it('names the argument holding a cmd metacharacter', () => {
    expect(mcpCatalogReasonText({ code: 'cmd-metacharacter', field: 'args[2]' })).toBe(
      'Its args[2] holds a character Windows reads as a command operator (& | < > ^ % ! " ( or )).'
    )
  })
})
