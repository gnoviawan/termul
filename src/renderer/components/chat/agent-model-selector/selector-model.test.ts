import { describe, expect, it } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import {
  buildAgentTabs,
  catalogFromPersisted,
  catalogFromSessionState,
  entryDisableReason,
  modelMatches
} from './selector-model'

function config(id: string, name: string): StoredAgentConfig {
  return { id, configId: id, name, command: id, args: [], env: {}, allowTerminal: false }
}

function entry(
  c: StoredAgentConfig | null,
  id: string,
  status: SupportedAcpAgentEntry['status'] = 'ready'
): SupportedAcpAgentEntry {
  return {
    id,
    configId: c?.configId ?? id,
    agent: { id, name: c?.name ?? id, version: '', description: '', distribution: {} },
    config: c,
    status,
    install: null,
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null
  }
}

const A = config('a', 'Alpha')
const B = config('b', 'Beta')
const C = config('c', 'Gamma')
const D = config('d', 'Delta')
const E = config('e', 'Epsilon')
const CONFIGS = [A, B, C, D, E]
const ENTRIES = CONFIGS.map((c) => entry(c, c.id))

describe('buildAgentTabs', () => {
  it('puts the current agent first, then the armed target, then ready agents', () => {
    const { visible, overflow } = buildAgentTabs({
      currentConfigId: 'c',
      armedConfigId: 'e',
      viewConfigId: null,
      entries: ENTRIES,
      agentConfigs: CONFIGS
    })
    expect(visible.map((t) => t.configId)).toEqual(['c', 'e', 'a', 'b'])
    expect(overflow.map((t) => t.configId)).toEqual(['d'])
  })

  it('keeps agents that are not ready behind More', () => {
    const { visible, overflow } = buildAgentTabs({
      currentConfigId: 'a',
      armedConfigId: null,
      viewConfigId: null,
      entries: [entry(A, 'a'), entry(null, 'opencode', 'install-required')],
      agentConfigs: [A]
    })
    expect(visible.map((t) => t.configId)).toEqual(['a'])
    expect(overflow.map((t) => t.configId)).toEqual(['opencode'])
  })

  it('swaps an agent opened from More into the last free slot', () => {
    const { visible } = buildAgentTabs({
      currentConfigId: 'a',
      armedConfigId: null,
      viewConfigId: 'e',
      entries: ENTRIES,
      agentConfigs: CONFIGS,
      max: 3
    })
    expect(visible.map((t) => t.configId)).toEqual(['a', 'b', 'e'])
  })

  it('keys a custom agent by its STORE id when its registry configId differs', () => {
    const custom = { ...config('custom-1', 'Custom'), configId: 'acp-registry:custom' }
    const { visible } = buildAgentTabs({
      currentConfigId: 'a',
      armedConfigId: null,
      viewConfigId: null,
      entries: [entry(A, 'a'), { ...entry(custom, 'custom'), configId: 'acp-registry:custom' }],
      agentConfigs: [A, custom]
    })
    expect(visible.map((t) => t.configId)).toEqual(['a', 'custom-1'])
  })

  it('pins the current agent from its stored config before the catalog resolves', () => {
    const { visible } = buildAgentTabs({
      currentConfigId: 'a',
      armedConfigId: null,
      viewConfigId: null,
      entries: [],
      agentConfigs: [A]
    })
    expect(visible).toEqual([{ configId: 'a', name: 'Alpha', config: A, entry: null }])
  })
})

describe('model catalogs', () => {
  const models = {
    currentModelId: 'm1',
    availableModels: [{ modelId: 'm1', name: 'Model One', description: 'Fast' }]
  }

  it('prefers the model config option over the native model state', () => {
    const catalog = catalogFromSessionState(models, [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'x',
        options: [{ value: 'x', name: 'X' }]
      }
    ])
    expect(catalog).toMatchObject({ id: 'model', source: 'config', currentValue: 'x' })
  })

  it('falls back to the native model state', () => {
    expect(catalogFromSessionState(models, [])).toEqual({
      id: 'model',
      source: 'models',
      options: [{ value: 'm1', name: 'Model One', description: 'Fast' }],
      currentValue: 'm1'
    })
  })

  it('reads a saved list and returns null for nothing saved', () => {
    expect(catalogFromPersisted(null)).toBeNull()
    expect(catalogFromPersisted({ models, modelOption: null, updatedAt: 1 })?.source).toBe('models')
  })

  it('matches on name, id, and description', () => {
    const model = { value: 'gpt-55', name: 'OpenAI/GPT-5.5', description: 'Smart' }
    expect(modelMatches(model, 'gpt-5.5')).toBe(true)
    expect(modelMatches(model, 'gpt-55')).toBe(true)
    expect(modelMatches(model, 'smart')).toBe(true)
    expect(modelMatches(model, 'grok')).toBe(false)
  })
})

describe('entryDisableReason', () => {
  it('gives a reason for agents that cannot run and null for ready ones', () => {
    expect(entryDisableReason(entry(A, 'a'))).toBeNull()
    expect(entryDisableReason(entry(null, 'x', 'manual-install'))).toBe('Manual install required')
    expect(entryDisableReason(entry(null, 'x', 'needs-runtime'))).toBe('Runtime missing')
    expect(entryDisableReason(entry(null, 'x', 'unavailable'))).toBe(
      'Not available on this platform'
    )
  })
})
