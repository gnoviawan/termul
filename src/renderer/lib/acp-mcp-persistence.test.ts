import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(),
    write: vi.fn()
  }
}))

import { persistenceApi } from '@/lib/api'
import {
  ACP_MCP_KEY,
  buildMcpServers,
  loadMcpServers,
  type StoredMcpServer,
  saveMcpServers,
  transportOf,
  validateMcpServer
} from './acp-mcp-persistence'

describe('validateMcpServer', () => {
  it('requires name', () => {
    expect(validateMcpServer({ type: 'stdio', command: 'x' }).valid).toBe(false)
  })
  it('stdio requires command', () => {
    expect(validateMcpServer({ type: 'stdio', name: 'fs' }).valid).toBe(false)
    expect(validateMcpServer({ type: 'stdio', name: 'fs', command: 'npx' }).valid).toBe(true)
  })
  it('http/sse require a valid url', () => {
    expect(validateMcpServer({ type: 'http', name: 'api' }).valid).toBe(false)
    expect(validateMcpServer({ type: 'http', name: 'api', url: 'not a url' }).valid).toBe(false)
    expect(validateMcpServer({ type: 'http', name: 'api', url: 'https://x.com/mcp' }).valid).toBe(
      true
    )
  })
})

describe('transportOf', () => {
  it('defaults to stdio', () => {
    expect(transportOf({ name: 'fs', command: 'x' })).toBe('stdio')
    expect(transportOf({ type: 'http', name: 'a', url: 'https://x' })).toBe('http')
  })
})

describe('buildMcpServers', () => {
  const registry: StoredMcpServer[] = [
    { id: 'm1', type: 'stdio', name: 'fs', command: 'npx', args: ['-y', 'fs'] },
    { id: 'm2', type: 'http', name: 'gh', url: 'https://api.github.com/mcp', headers: [] }
  ]
  it('maps selected ids to wire shape and strips the local id', () => {
    const out = buildMcpServers(registry, ['m2'])
    expect(out).toEqual([
      { type: 'http', name: 'gh', url: 'https://api.github.com/mcp', headers: [] }
    ])
    expect((out[0] as unknown as Record<string, unknown>).id).toBeUndefined()
  })
  it('preserves selection order and skips unknown ids', () => {
    const out = buildMcpServers(registry, ['m2', 'ghost', 'm1'])
    expect(out.map((s) => s.name)).toEqual(['gh', 'fs'])
  })
  it('returns [] for no selection', () => {
    expect(buildMcpServers(registry, [])).toEqual([])
  })
})

describe('registry I/O', () => {
  beforeEach(() => vi.clearAllMocks())
  it('loadMcpServers returns [] on KEY_NOT_FOUND', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND'
    })
    expect(await loadMcpServers()).toEqual([])
  })
  it('saveMcpServers writes under the dedicated key and throws on failure', async () => {
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    await saveMcpServers([])
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_MCP_KEY, [])
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'nope'
    })
    await expect(saveMcpServers([])).rejects.toThrow(/nope/)
  })
})
