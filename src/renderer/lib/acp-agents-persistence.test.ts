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
      { id: 'a1', name: 'Gemini', command: 'gemini', args: [], env: {} }
    ]
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: list
    })
    expect(await loadAgentConfigs()).toEqual(list)
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
})
