import { describe, expect, it } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import {
  type AgentTab,
  agentInRowName,
  agentTrackCapacity,
  buildAgentTabs,
  capabilitySummary,
  catalogFromPersisted,
  catalogFromSessionState,
  editButtonAccessibleName,
  entryDisableReason,
  favoriteFor,
  isContextOption,
  modelMatches,
  orderAgentTabs,
  resolveFavorites,
  rowAccessibleName,
  rowHasDescription,
  rowTooltip,
  rowTooltipDescription,
  spacingPx,
  splitAgentTabs,
  splitContextOption,
  stableAgentTabs
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

const tab = (
  id: string,
  name: string,
  status: SupportedAcpAgentEntry['status'] = 'ready'
): AgentTab => {
  const c = config(id, name)
  return { configId: id, name, config: status === 'ready' ? c : null, entry: entry(c, id, status) }
}
const ids = (tabs: readonly AgentTab[]): string[] => tabs.map((t) => t.configId)

describe('orderAgentTabs', () => {
  it('puts installed agents before the rest', () => {
    const order = orderAgentTabs([
      tab('a', 'Amp', 'install-required'),
      tab('z', 'Zed', 'ready'),
      tab('n', 'Node thing', 'needs-runtime'),
      tab('c', 'Codex', 'ready')
    ])
    expect(ids(order)).toEqual(['c', 'z', 'a', 'n'])
  })

  it('sorts each group A to Z, ignoring case and accents', () => {
    const order = orderAgentTabs([
      tab('g', 'gemini'),
      tab('cl', 'Claude Agent'),
      tab('e', 'Éclair'),
      tab('cu', 'cursor'),
      tab('o', 'opencode', 'install-required'),
      tab('ai', 'Aider', 'manual-install')
    ])
    expect(ids(order)).toEqual(['cl', 'cu', 'e', 'g', 'ai', 'o'])
  })

  it('counts a stored agent with no registry entry as installed', () => {
    const custom: AgentTab = {
      configId: 'x',
      name: 'Zz custom',
      config: config('x', 'Zz'),
      entry: null
    }
    expect(ids(orderAgentTabs([tab('a', 'Amp', 'install-required'), custom]))).toEqual(['x', 'a'])
  })

  it('does not mutate its input', () => {
    const input = [tab('b', 'Beta'), tab('a', 'Alpha')]
    orderAgentTabs(input)
    expect(ids(input)).toEqual(['b', 'a'])
  })
})

describe('splitAgentTabs', () => {
  const ten = Array.from({ length: 10 }, (_, i) => tab(`t${i}`, `Agent ${i}`))

  it('shows every tab and no More when they fit', () => {
    expect(splitAgentTabs(ten, 10)).toEqual({ visible: ten, overflow: [] })
    expect(splitAgentTabs(ten.slice(0, 3), 10).overflow).toEqual([])
  })

  it('gives the last slot to More when they overflow', () => {
    const { visible, overflow } = splitAgentTabs(ten, 4)
    expect(ids(visible)).toEqual(['t0', 't1', 't2'])
    expect(ids(overflow)).toEqual(['t3', 't4', 't5', 't6', 't7', 't8', 't9'])
  })
})

describe('stableAgentTabs (V2)', () => {
  const entries = [
    entry(C, 'c'),
    entry(A, 'a'),
    entry(null, 'opencode', 'install-required'),
    entry(E, 'e'),
    entry(B, 'b'),
    entry(D, 'd')
  ]
  const build = (over: { current?: string | null; armed?: string | null; view?: string | null }) =>
    stableAgentTabs({
      currentConfigId: over.current ?? null,
      armedConfigId: over.armed ?? null,
      viewConfigId: over.view ?? null,
      entries,
      agentConfigs: CONFIGS,
      capacity: 4
    })

  it('keeps one order whichever agent is current, armed, or viewed', () => {
    const base = build({ current: 'a' })
    expect(ids(base.visible)).toEqual(['a', 'b', 'd'])
    expect(ids(base.overflow)).toEqual(['e', 'c', 'opencode'])
    for (const over of [
      { current: 'e' },
      { current: 'a', armed: 'c' },
      { current: 'a', view: 'e' }
    ]) {
      const next = build(over)
      expect(ids(next.visible)).toEqual(ids(base.visible))
      expect(ids(next.overflow)).toEqual(ids(base.overflow))
    }
  })

  it('leaves the active agent in its slot behind More instead of pulling it forward', () => {
    const { visible, overflow } = build({ current: 'c', view: 'c' })
    expect(ids(visible)).not.toContain('c')
    expect(ids(overflow)[1]).toBe('c')
  })

  it('adds the current agent from its stored config before the catalog lists it', () => {
    const { visible } = stableAgentTabs({
      currentConfigId: 'a',
      armedConfigId: null,
      viewConfigId: null,
      entries: [],
      agentConfigs: [A],
      capacity: 10
    })
    expect(visible).toEqual([{ configId: 'a', name: 'Alpha', config: A, entry: null }])
  })
})

describe('agentTrackCapacity', () => {
  it('fits ten 28px tabs in the 288px rail (280px inside its padding)', () => {
    expect(agentTrackCapacity({ rail: 'left', touch: false, width: null })).toBe(10)
  })
  it('fits six 44px touch tabs in the rail', () => {
    expect(agentTrackCapacity({ rail: 'left', touch: true, width: null })).toBe(6)
  })
  it('fits eight 36px tabs in the 300px desktop strip', () => {
    expect(agentTrackCapacity({ rail: 'top', touch: false, width: null })).toBe(8)
  })
  it('sizes the touch strip from its measured width, with a fallback before the measure', () => {
    expect(agentTrackCapacity({ rail: 'top', touch: true, width: 390 })).toBe(8)
    expect(agentTrackCapacity({ rail: 'top', touch: true, width: null })).toBe(5)
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

  it('lists the models inside grouped select options', () => {
    const catalog = catalogFromSessionState(models, [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-flash',
        options: [
          { value: 'gemini-flash', name: 'Gemini Flash' },
          {
            group: 'anthropic',
            name: 'Anthropic',
            options: [{ value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced' }]
          }
        ]
      }
    ])
    expect(catalog?.options).toEqual([
      { value: 'gemini-flash', name: 'Gemini Flash', description: null },
      { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced' }
    ])
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

describe('capabilitySummary', () => {
  it('lists the prompt content and MCP transports the agent advertises', () => {
    expect(
      capabilitySummary({
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false }
      })
    ).toBe('Accepts: Text · Images · Embedded context\nMCP servers: stdio · HTTP')
  })

  it('lists SSE and audio when the agent advertises them', () => {
    expect(
      capabilitySummary({
        promptCapabilities: { audio: true },
        mcpCapabilities: { http: true, sse: true }
      })
    ).toBe('Accepts: Text · Audio (cannot attach yet)\nMCP servers: stdio · HTTP · SSE')
  })

  it('names the baseline when the agent advertises nothing beyond it', () => {
    expect(
      capabilitySummary({
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false }
      })
    ).toBe('Accepts: Text only\nMCP servers: stdio only')
  })

  it('shows only the block the agent advertised', () => {
    expect(capabilitySummary({ mcpCapabilities: { sse: true } })).toBe('MCP servers: stdio · SSE')
  })

  it.each([
    ['no capabilities', undefined],
    ['null capabilities', null],
    ['capabilities without either field', { loadSession: true }],
    ['null capability fields', { promptCapabilities: null, mcpCapabilities: null }]
  ] as const)('is null for %s', (_name, capabilities) => {
    expect(capabilitySummary(capabilities)).toBeNull()
  })
})

function select(
  id: string,
  category: string | undefined,
  values: Array<[string, string]>,
  name = 'Context'
): SessionConfigOption {
  return {
    id,
    name,
    category,
    type: 'select',
    currentValue: values[0]?.[0] ?? '',
    options: values.map(([value, label]) => ({ value, name: label }))
  }
}

describe('isContextOption', () => {
  const VALUES: Array<[string, string]> = [
    ['300k', '300K'],
    ['1m', '1M']
  ]

  it.each([
    ['context', 'other'],
    ['context', 'model_config'],
    ['context', undefined],
    ['context_window', 'model_config'],
    ['contextWindow', 'other'],
    ['context-size', 'model_config']
  ])('matches id %s with category %s', (id, category) => {
    expect(isContextOption(select(id, category, VALUES))).toBe(true)
  })

  it('rejects a context id under another category', () => {
    expect(isContextOption(select('context', 'thought_level', VALUES))).toBe(false)
    expect(isContextOption(select('context', 'model', VALUES))).toBe(false)
  })

  it('never matches on the value labels', () => {
    // An effort-like option whose values happen to read like context sizes.
    const lookalike = select('size', 'other', [
      ['200k', '200K'],
      ['1m', '1M']
    ])
    expect(isContextOption(lookalike)).toBe(false)
    // A context option is found whatever its labels say.
    expect(isContextOption(select('context', 'other', [['big', 'Large window']]))).toBe(true)
  })

  it('needs a select with at least one value', () => {
    expect(isContextOption(select('context', 'other', []))).toBe(false)
    expect(
      isContextOption({ id: 'context', name: 'Context', type: 'boolean', currentValue: true })
    ).toBe(false)
  })

  it('does not match ids that only contain the word', () => {
    expect(isContextOption(select('max_context_tokens', 'other', VALUES))).toBe(false)
    expect(isContextOption(select('embedded_context', 'other', VALUES))).toBe(false)
  })
})

describe('splitContextOption', () => {
  it('takes the first context option and keeps the rest in order', () => {
    const mode = select('mode', 'other', [['plan', 'Plan']], 'Mode')
    const context = select('context', 'model_config', [
      ['256k', '256K'],
      ['500k', '500K']
    ])
    const second = select('context_window', 'model_config', [['1m', '1M']])
    expect(splitContextOption([mode, context, second])).toEqual({
      context,
      rest: [mode, second]
    })
  })

  it('returns no context when the agent sends none', () => {
    const mode = select('mode', 'other', [['plan', 'Plan']], 'Mode')
    expect(splitContextOption([mode])).toEqual({ context: null, rest: [mode] })
  })
})

describe('favorites', () => {
  /** Registry configId differs from the stored id (imported custom agent). */
  const STORED = config('custom-1', 'Claude Agent')
  const IMPORTED = { ...entry({ ...STORED, configId: 'acp-registry:claude' }, 'claude') }

  it('keys a favorite by the armable STORE id, never the agent id', () => {
    expect(favoriteFor(IMPORTED, [STORED], 'opus')).toEqual({
      configId: 'custom-1',
      modelId: 'opus'
    })
  })

  it('has no favorite for an agent that cannot be armed', () => {
    expect(favoriteFor(entry(null, 'opencode'), [STORED], 'x')).toBeNull()
  })

  it('resolves favorites in starred order and drops missing ones', () => {
    const catalog = {
      id: 'model',
      source: 'config' as const,
      currentValue: null,
      options: [
        { value: 'opus', name: 'Opus' },
        { value: 'haiku', name: 'Haiku' }
      ]
    }
    const result = resolveFavorites(
      [
        { configId: 'a', modelId: 'haiku' },
        { configId: 'a', modelId: 'gone' },
        { configId: 'unknown', modelId: 'opus' },
        { configId: 'a', modelId: 'opus' }
      ],
      (id) => (id === 'a' ? catalog : null)
    )
    expect(result.map((f) => f.model.name)).toEqual(['Haiku', 'Opus'])
  })

  it('hides (keeps) favorites of an agent that is not installed', () => {
    const catalog = {
      id: 'model',
      source: 'config' as const,
      currentValue: null,
      options: [{ value: 'opus', name: 'Opus' }]
    }
    const favorites = [
      { configId: 'a', modelId: 'opus' },
      { configId: 'b', modelId: 'opus' }
    ]
    const result = resolveFavorites(
      favorites,
      () => catalog,
      (id) => id === 'a'
    )
    expect(result.map((f) => f.configId)).toEqual(['a'])
    expect(favorites).toHaveLength(2)
  })
})

describe('spacingPx', () => {
  it('reads the 4px Tailwind spacing step', () => {
    expect(spacingPx('max-h-72')).toBe(288)
    expect(spacingPx('size-7')).toBe(28)
    expect(spacingPx('size-11')).toBe(44)
    expect(spacingPx('py-1')).toBe(4)
  })

  it('throws on a class with no spacing step', () => {
    expect(() => spacingPx('max-h-full')).toThrow('Not a spacing class')
  })
})

describe('rowAccessibleName', () => {
  it('a short name', () => {
    expect(rowAccessibleName({ name: 'Claude Opus' })).toBe('Claude Opus')
  })

  it('a long name, whole', () => {
    const long = 'Claude 4.7 Opus Thinking Max with Extended 1M Context Window Preview Build'
    expect(rowAccessibleName({ name: long })).toBe(long)
  })

  it('trims a padded name', () => {
    expect(rowAccessibleName({ name: '  Claude Opus  ' })).toBe('Claude Opus')
    expect(rowAccessibleName({ name: '\tClaude Opus\n' })).toBe('Claude Opus')
  })

  it('with an agent name', () => {
    expect(rowAccessibleName({ name: ' Opus via Claude ', agentName: 'Claude Agent' })).toBe(
      'Opus via Claude · Claude Agent'
    )
  })
})

describe('editButtonAccessibleName', () => {
  const sections = 'Thinking and Context'

  it('with a level: "Edit <name>, thinking <level>"', () => {
    expect(editButtonAccessibleName({ name: 'Claude Opus', thinking: 'High', sections })).toBe(
      'Edit Claude Opus, thinking High'
    )
    expect(
      editButtonAccessibleName({
        name: 'Claude 4.7 Opus Thinking',
        thinking: 'Extra High',
        sections
      })
    ).toBe('Edit Claude 4.7 Opus Thinking, thinking Extra High')
  })

  it('trims a padded name', () => {
    expect(editButtonAccessibleName({ name: '  Claude Opus  ', thinking: 'High', sections })).toBe(
      'Edit Claude Opus, thinking High'
    )
    expect(editButtonAccessibleName({ name: '  Claude Opus  ', sections })).toBe(
      'Edit Thinking and Context for Claude Opus'
    )
  })

  it('no level: what it edits, as before', () => {
    expect(editButtonAccessibleName({ name: 'Claude Opus', sections })).toBe(
      'Edit Thinking and Context for Claude Opus'
    )
    expect(editButtonAccessibleName({ name: 'Claude Opus', thinking: '', sections })).toBe(
      'Edit Thinking and Context for Claude Opus'
    )
    expect(editButtonAccessibleName({ name: 'Claude Opus', sections: 'Fast mode' })).toBe(
      'Edit Fast mode for Claude Opus'
    )
  })
})

describe('editButtonAccessibleName in Favorites', () => {
  const sections = 'Thinking and Context'

  it('with a level: "Edit <name> in Favorites, thinking <level>", the level last', () => {
    expect(
      editButtonAccessibleName({
        name: ' Claude Opus ',
        thinking: 'High',
        sections,
        inFavorites: true
      })
    ).toBe('Edit Claude Opus in Favorites, thinking High')
  })

  it('no level: the fallback, in Favorites', () => {
    expect(editButtonAccessibleName({ name: 'Claude Opus', sections, inFavorites: true })).toBe(
      'Edit Thinking and Context for Claude Opus in Favorites'
    )
  })

  it('outside Favorites the name is unchanged', () => {
    expect(
      editButtonAccessibleName({
        name: 'Claude Opus',
        thinking: 'High',
        sections,
        inFavorites: false
      })
    ).toBe('Edit Claude Opus, thinking High')
  })
})

describe('rowTooltip', () => {
  it('leads with the full, trimmed model name', () => {
    expect(rowTooltip({ name: '  Claude 4.7 Opus Thinking ' })).toBe('Claude 4.7 Opus Thinking')
  })

  it('then the agent, then the description', () => {
    expect(
      rowTooltip({ name: 'Claude Opus', agentName: 'Claude Agent', details: 'Most capable' })
    ).toBe('Claude Opus\n\nClaude Agent\n\nMost capable')
    expect(rowTooltip({ name: 'Claude Opus', details: 'Most capable' })).toBe(
      'Claude Opus\n\nMost capable'
    )
  })
})

describe('rowTooltipDescription', () => {
  it('leaves the name out: the row is already named by it', () => {
    expect(rowTooltipDescription({ agentInName: false, details: 'Most capable' })).toBe(
      'Most capable'
    )
  })

  it('leaves the agent out when the row name already says it', () => {
    expect(
      rowTooltipDescription({
        agentName: 'Claude Agent',
        agentInName: true,
        details: 'Most capable'
      })
    ).toBe('Most capable')
    expect(rowTooltipDescription({ agentName: 'Claude Agent', agentInName: true })).toBe(' ')
  })

  it('keeps the agent when the row name does not say it', () => {
    expect(
      rowTooltipDescription({
        agentName: 'Claude Agent',
        agentInName: false,
        details: 'Most capable'
      })
    ).toBe('Claude Agent\n\nMost capable')
  })

  it('is blank, not empty, with nothing more to say', () => {
    expect(rowTooltipDescription({ agentInName: false })).toBe(' ')
  })
})

describe('agentInRowName', () => {
  it('matches what rowAccessibleName says', () => {
    for (const agentName of [undefined, '', 'Claude Agent']) {
      const named = rowAccessibleName({ name: 'Opus', agentName }) !== 'Opus'
      expect(agentInRowName(agentName)).toBe(named)
    }
  })
})

describe('rowHasDescription', () => {
  it('is false for the blank copy, true for any text', () => {
    expect(rowHasDescription(' ')).toBe(false)
    expect(rowHasDescription('')).toBe(false)
    expect(rowHasDescription('Most capable')).toBe(true)
  })
})
