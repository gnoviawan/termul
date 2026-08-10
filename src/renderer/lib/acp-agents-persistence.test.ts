import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(),
    write: vi.fn()
  }
}))

import { persistenceApi } from '@/lib/api'
import {
  ACP_AGENTS_KEY,
  loadAgentConfigs,
  looksLikeSecretValue,
  type StoredAgentConfig,
  saveAgentConfigs,
  validateAgentConfig
} from './acp-agents-persistence'

describe('validateAgentConfig', () => {
  it('requires non-empty name and command', () => {
    expect(validateAgentConfig({ name: '', command: 'x' }).valid).toBe(false)
    expect(validateAgentConfig({ name: 'A', command: '' }).valid).toBe(false)
    expect(validateAgentConfig({ name: '  ', command: '  ' }).valid).toBe(false)
    expect(validateAgentConfig({ name: 'Gemini', command: 'gemini' }).valid).toBe(true)
  })
  it('reports each missing field', () => {
    expect(validateAgentConfig({}).errors).toHaveLength(2)
  })
  it('rejects args that is not an array', () => {
    const r = validateAgentConfig({
      name: 'H',
      command: 'node',
      args: 'not-array' as unknown as string[]
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('args must be an array')
  })
  it('rejects env that is not an object', () => {
    const r = validateAgentConfig({
      name: 'H',
      command: 'node',
      env: 'nope' as unknown as Record<string, string>
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('env must be an object')
  })
  it('rejects env values that are not strings', () => {
    const r = validateAgentConfig({
      name: 'H',
      command: 'node',
      env: { K: 123 as unknown as string }
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('env values must be strings')
  })
  it('rejects args elements that are not strings', () => {
    const r = validateAgentConfig({
      name: 'H',
      command: 'node',
      args: [123 as unknown as string, 'ok']
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('args must be an array of strings')
  })
  it('rejects env values that are objects/null', () => {
    const r = validateAgentConfig({
      name: 'H',
      command: 'node',
      env: { K: { secret: true } as unknown as string }
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('env values must be strings')
  })
  it('rejects allowTerminal that is not a boolean', () => {
    const r = validateAgentConfig({
      name: 'H',
      command: 'node',
      allowTerminal: 'yes' as unknown as boolean
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('allowTerminal must be a boolean')
  })
  it('accepts undefined args/env/allowTerminal', () => {
    expect(validateAgentConfig({ name: 'H', command: 'node' }).valid).toBe(true)
  })
})

describe('looksLikeSecretValue', () => {
  it('treats $VAR placeholders as non-secret', () => {
    expect(looksLikeSecretValue('$ANTHROPIC_API_KEY')).toBe(false)
    expect(looksLikeSecretValue('$X')).toBe(false)
  })
  it('treats long literals as secrets', () => {
    expect(looksLikeSecretValue('sk-abc123def456ghi')).toBe(true)
  })
  it('treats short/empty values as non-secret', () => {
    expect(looksLikeSecretValue('')).toBe(false)
    expect(looksLikeSecretValue('dev')).toBe(false)
  })
})

describe('load/save agent configs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns [] when the key is missing', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND'
    })
    expect(await loadAgentConfigs()).toEqual([])
  })

  it('returns the stored list', async () => {
    const list: StoredAgentConfig[] = [
      {
        id: 'a1',
        configId: 'a1',
        name: 'Gemini',
        command: 'gemini',
        args: [],
        env: {},
        allowTerminal: false
      }
    ]
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: list
    })
    expect(await loadAgentConfigs()).toEqual(list)
  })

  it('backfills configId = id for persisted configs missing one', async () => {
    // Migration (OQ1): pre-feature persisted configs may lack `configId`. On
    // load they are backfilled so the configId-required spawn path succeeds.
    const stored = [
      { id: 'acp-registry:gemini', name: 'Gemini', command: 'gemini', args: [], env: {} },
      { id: 'custom-abc12345', name: 'H', command: 'node', args: [], env: {} }
    ]
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: stored
    })
    const loaded = await loadAgentConfigs()
    expect(loaded[0].configId).toBe('acp-registry:gemini')
    expect(loaded[1].configId).toBe('custom-abc12345')
  })

  it('preserves an existing configId on load', async () => {
    const stored: StoredAgentConfig[] = [
      {
        id: 'custom-abc12345',
        configId: 'custom-honored',
        name: 'H',
        command: 'node',
        args: [],
        env: {}
      }
    ]
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: stored
    })
    const loaded = await loadAgentConfigs()
    expect(loaded[0].configId).toBe('custom-honored')
  })

  it('writes under the dedicated key and throws on failure', async () => {
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    await saveAgentConfigs([])
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_AGENTS_KEY, [])
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'disk full'
    })
    await expect(saveAgentConfigs([])).rejects.toThrow(/disk full/)
  })

  it('rejects a raw secret literal in env at the persistence boundary (AD-6)', async () => {
    // The no-raw-secrets-on-disk invariant: `saveAgentConfigs` throws before
    // writing so no future caller can bypass the dialog-layer secret guard.
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    const list: StoredAgentConfig[] = [
      {
        id: 'x',
        name: 'A',
        command: 'a',
        args: [],
        env: { K: 'sk-abc123def456ghi' }
      }
    ]
    const err = await saveAgentConfigs(list).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    const msg = String(err)
    expect(msg).toContain('secure storage')
    expect(msg).toContain('$K')
    expect(persistenceApi.write).not.toHaveBeenCalled()
  })

  it('accepts $VAR placeholders in env at the persistence boundary', async () => {
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    const list: StoredAgentConfig[] = [
      {
        id: 'x',
        name: 'A',
        command: 'a',
        args: [],
        env: { K: '$K' }
      }
    ]
    await saveAgentConfigs(list)
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_AGENTS_KEY, list)
  })

  it('filters out malformed (null/non-object/id-less) persisted entries on load', async () => {
    // Defense-in-depth: a corrupt persisted array must never crash the load or
    // the downstream merge (`resolveSupportedAcpAgents` calls `.startsWith` on
    // `config.id`). Null/non-object/id-less entries are dropped silently.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [
        null,
        'not-an-object',
        { name: 'NoId', command: 'c', args: [], env: {} },
        { id: 'custom-ok', name: 'Ok', command: 'c', args: [], env: {} }
      ]
    })
    const loaded = await loadAgentConfigs()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('custom-ok')
    expect(loaded[0].configId).toBe('custom-ok')
  })

  it('rejects a non-string configId and backfills from id without crashing', async () => {
    // CodeRabbit: a persisted record with configId: 123 (number) must not throw
    // at startup when loadAgentConfigs calls .trim(). Validate the type before
    // trimming; treat a non-string configId as missing and backfill from id.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'custom-1', name: 'H', command: 'node', args: [], env: {}, configId: 123 }]
    })
    const loaded = await loadAgentConfigs()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].configId).toBe('custom-1')
  })

  it('normalizes omitted/legacy optional fields to safe defaults on load', async () => {
    // A legacy persisted record may omit args/env/allowTerminal. The loader
    // normalizes them to their established defaults so downstream consumers
    // (merge, spawn) never see `undefined`.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'legacy-1', name: 'Legacy', command: 'legacy-bin' }]
    })
    const loaded = await loadAgentConfigs()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].args).toEqual([])
    expect(loaded[0].env).toEqual({})
    expect(loaded[0].allowTerminal).toBe(false)
    expect(loaded[0].configId).toBe('legacy-1')
  })

  it('rejects whitespace-only id/name/command and trims accepted identifiers (CodeRabbit)', async () => {
    // A record with a whitespace-only id/name/command is meaningless and must
    // be dropped (not just `length > 0`). Accepted identifiers are trimmed.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [
        { id: '   ', name: 'Ws', command: 'c', args: [], env: {} },
        { id: 'ok', name: '  ', command: 'c', args: [], env: {} },
        { id: 'trim-me', name: ' Trim Me ', command: ' trim-bin ', args: [], env: {} }
      ]
    })
    const loaded = await loadAgentConfigs()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('trim-me')
    expect(loaded[0].name).toBe('Trim Me')
    expect(loaded[0].command).toBe('trim-bin')
  })

  it('defaults args to [] when an element is not a string, instead of casting (CodeRabbit)', async () => {
    // args = [123, "ok"] has a non-string element — the loader must NOT cast it
    // to string[] (the number would reach the Rust serde spawn path as a
    // confusing type error). Default to [] instead.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'a', name: 'A', command: 'c', args: [123, 'ok'], env: {} }]
    })
    const loaded = await loadAgentConfigs()
    expect(loaded[0].args).toEqual([])
  })

  it('defaults env to {} when a value is not a string, instead of casting (CodeRabbit)', async () => {
    // env = { K: 123 } has a non-string value — default to {} instead of
    // casting the number through to the spawn path.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'a', name: 'A', command: 'c', args: [], env: { K: 123, OK: 'v' } }]
    })
    const loaded = await loadAgentConfigs()
    expect(loaded[0].env).toEqual({})
  })
})
