import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  crawl,
  META_FILE,
  SNAPSHOT_FILE,
  verifySnapshot
} from './fetch-mcp-registry-snapshot.mjs'

const OFFICIAL = 'io.modelcontextprotocol.registry/official'

function row(name: string, version: string, status: string, isLatest: boolean) {
  return {
    server: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name,
      version,
      description: 'd',
      icons: [{ src: 'https://example.com/icon.png' }],
      _meta: { 'com.example/publisher': { stars: 1 } },
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]
    },
    _meta: {
      [OFFICIAL]: { status, isLatest, publishedAt: 'p', updatedAt: 'u', statusChangedAt: 's' }
    }
  }
}

describe('buildSnapshot', () => {
  it('keeps latest rows slimmed and a status row for every version', () => {
    const snapshot = buildSnapshot([
      row('io.example/b', '2.0.0', 'deleted', true),
      row('io.example/a', '1.0.0', 'active', false),
      row('io.example/a', '1.1.0', 'deprecated', true)
    ])
    expect(snapshot).toEqual({
      formatVersion: 1,
      servers: [
        {
          server: {
            name: 'io.example/a',
            version: '1.1.0',
            description: 'd',
            remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]
          },
          _meta: {
            [OFFICIAL]: { status: 'deprecated', isLatest: true, publishedAt: 'p', updatedAt: 'u' }
          }
        },
        {
          server: {
            name: 'io.example/b',
            version: '2.0.0',
            description: 'd',
            remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]
          },
          _meta: {
            [OFFICIAL]: { status: 'deleted', isLatest: true, publishedAt: 'p', updatedAt: 'u' }
          }
        }
      ],
      versions: [
        ['io.example/a', '1.0.0', 'active'],
        ['io.example/a', '1.1.0', 'deprecated'],
        ['io.example/b', '2.0.0', 'deleted']
      ]
    })
  })

  it('keeps only the named servers when given a list', () => {
    const snapshot = buildSnapshot(
      [row('io.example/a', '1.0.0', 'active', true), row('io.example/b', '1.0.0', 'active', true)],
      new Set(['io.example/b'])
    )
    expect(snapshot.servers.map((r: { server: { name: string } }) => r.server.name)).toEqual([
      'io.example/b'
    ])
    expect(snapshot.versions).toEqual([['io.example/b', '1.0.0', 'active']])
  })
})

describe('crawl', () => {
  it('follows nextCursor until the registry stops returning one', async () => {
    const cursors: Array<string | null> = []
    const pages: Record<string, unknown> = {
      start: { servers: [1, 2], metadata: { nextCursor: 'c2' } },
      c2: { servers: [3], metadata: {} }
    }
    const rows = await crawl(async (cursor: string | null) => {
      cursors.push(cursor)
      return pages[cursor ?? 'start']
    })
    expect(rows).toEqual([1, 2, 3])
    expect(cursors).toEqual([null, 'c2'])
  })
})

describe('verifySnapshot', () => {
  function write(servers: number, sha?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-snapshot-'))
    const snapshot = {
      formatVersion: 1,
      servers: Array.from({ length: servers }, (_, i) =>
        row(`io.example/s${i}`, '1.0.0', 'active', true)
      ),
      versions: []
    }
    const gz = gzipSync(Buffer.from(JSON.stringify(snapshot)))
    const sha256 = sha ?? createHash('sha256').update(gz).digest('hex')
    writeFileSync(join(dir, SNAPSHOT_FILE), gz)
    writeFileSync(join(dir, META_FILE), JSON.stringify({ sha256, fetchedAt: 'now', servers }))
    return dir
  }

  it('accepts a snapshot whose bytes match its sha256', () => {
    expect(verifySnapshot(write(3), 3)).toMatchObject({ servers: 3 })
  })

  it('rejects a mismatched sha256 or a truncated crawl', () => {
    expect(() => verifySnapshot(write(3, 'f'.repeat(64)), 3)).toThrow(/does not match/)
    expect(() => verifySnapshot(write(3), 4)).toThrow(/minimum 4/)
  })
})
