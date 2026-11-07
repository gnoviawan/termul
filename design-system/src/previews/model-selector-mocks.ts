/**
 * Mock data for the model selector canvas entries: six agents (so the More tab
 * shows), 22 Cursor models with long names, effort, Fast, and the context
 * window. Context values follow what Cursor sends: 300K | 1M on most models,
 * 256K | 500K on some. The views render these labels from the option data.
 */
import { useCallback, useMemo, useState } from 'react'
import type { DraftSelector } from '@/components/chat/agent-model-selector/AgentModelSelector'
import type { SelectorSource } from '@/components/chat/agent-model-selector/selector-source'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { useAcpStore } from '@/stores/acp-store'

interface MockAgent {
  /** Registry id; doubles as the icon template id. */
  id: string
  name: string
  /** Null: not installed (the More tab shows an install row). */
  configured: boolean
  models: MockModel[]
}

type ContextSet = 'wide' | 'narrow' | null

interface MockModel {
  value: string
  name: string
  description?: string
  effort?: boolean
  fast?: boolean
  context?: ContextSet
}

/** Context values per model family, as the agent sends them. */
const CONTEXT_VALUES: Record<Exclude<ContextSet, null>, Array<{ value: string; name: string }>> = {
  wide: [
    { value: '300k', name: '300K' },
    { value: '1m', name: '1M' }
  ],
  narrow: [
    { value: '256k', name: '256K' },
    { value: '500k', name: '500K' }
  ]
}

const EFFORT_VALUES = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Extra High' }
]

const CURSOR_MODELS: MockModel[] = [
  { value: 'auto', name: 'Auto', description: 'Picks a model per request' },
  { value: 'composer-2', name: 'Composer 2', fast: true },
  {
    value: 'claude-4.7-opus-thinking',
    name: 'Claude 4.7 Opus Thinking',
    effort: true,
    fast: true,
    context: 'wide'
  },
  { value: 'claude-4.7-opus', name: 'Claude 4.7 Opus', context: 'wide' },
  {
    value: 'claude-4.6-sonnet-thinking-max',
    name: 'Claude 4.6 Sonnet Thinking (Max Mode)',
    effort: true,
    context: 'wide'
  },
  { value: 'claude-4.6-sonnet', name: 'Claude 4.6 Sonnet', context: 'wide' },
  { value: 'claude-4.5-haiku', name: 'Claude 4.5 Haiku', context: 'wide' },
  { value: 'gpt-5.4', name: 'GPT-5.4', effort: true, context: 'narrow' },
  { value: 'gpt-5.4-codex', name: 'GPT-5.4 Codex', effort: true, fast: true, context: 'narrow' },
  {
    value: 'gpt-5.4-codex-max',
    name: 'GPT-5.4 Codex Max (Extra High Reasoning)',
    effort: true,
    context: 'narrow'
  },
  { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', effort: true, context: 'narrow' },
  { value: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark Preview', context: 'narrow' },
  { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', effort: true, context: 'wide' },
  {
    value: 'gemini-3.1-pro-long',
    name: 'Gemini 3.1 Pro Preview (Long Context Experimental)',
    context: 'wide'
  },
  { value: 'gemini-3-flash', name: 'Gemini 3 Flash', context: 'narrow' },
  { value: 'kimi-k2.5-thinking', name: 'Kimi K2.5 Thinking Turbo', effort: true },
  { value: 'deepseek-v4', name: 'DeepSeek V4' },
  { value: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus 480B A35B Instruct' },
  { value: 'glm-5', name: 'GLM-5' },
  { value: 'o4-deep-research', name: 'o4 Deep Research', effort: true },
  { value: 'grok-code-fast-2', name: 'Grok Code Fast 2', fast: true },
  { value: 'cursor-small', name: 'Cursor Small' }
]

const AGENTS: MockAgent[] = [
  { id: 'cursor', name: 'Cursor', configured: true, models: CURSOR_MODELS },
  {
    id: 'claude-acp',
    name: 'Claude Agent',
    configured: true,
    models: [
      { value: 'default', name: 'Default (recommended)', effort: true },
      { value: 'opus', name: 'Claude Opus 4.7', effort: true },
      { value: 'opus-1m', name: 'Claude Opus 4.7 with 1M context window', effort: true },
      { value: 'sonnet', name: 'Claude Sonnet 4.6', effort: true },
      { value: 'haiku', name: 'Claude Haiku 4.5' }
    ]
  },
  {
    id: 'codex-acp',
    name: 'Codex',
    configured: true,
    models: [
      { value: 'gpt-5.4-codex', name: 'gpt-5.4-codex', effort: true },
      { value: 'gpt-5.4', name: 'gpt-5.4', effort: true },
      { value: 'gpt-5.4-mini', name: 'gpt-5.4-mini', effort: true },
      { value: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark' }
    ]
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    configured: true,
    models: [
      { value: 'auto', name: 'Auto (Gemini 3)' },
      { value: 'gemini-3.1-pro', name: 'gemini-3.1-pro-preview' },
      { value: 'gemini-3-flash', name: 'gemini-3-flash-preview' }
    ]
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    configured: true,
    models: [
      { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { value: 'gpt-5.4', name: 'GPT-5.4' },
      { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }
    ]
  },
  { id: 'opencode', name: 'OpenCode', configured: false, models: [] }
]

/**
 * More agents for the "many agents" entry: with AGENTS, 11 installed and 3
 * to install, past the rail's 10 slots and the strip's 8.
 */
const EXTRA_AGENTS: MockAgent[] = [
  ...['Amp', 'Auggie', 'Droid', 'Goose', 'Kimi CLI', 'Qwen Code'].map((name) => {
    const id = name.toLowerCase().replace(/\s/g, '-')
    return { id, name, configured: true, models: [{ value: 'default', name: `${name} default` }] }
  }),
  { id: 'aider', name: 'Aider', configured: false, models: [] },
  { id: 'crush', name: 'Crush', configured: false, models: [] }
]

const configIdOf = (agentId: string): string => `acp-registry:${agentId}`

function configsOf(agents: readonly MockAgent[]): StoredAgentConfig[] {
  return agents
    .filter((a) => a.configured)
    .map((a) => ({
      id: configIdOf(a.id),
      configId: configIdOf(a.id),
      name: a.name,
      command: a.id,
      args: [],
      env: {},
      allowTerminal: false,
      templateId: a.id
    }))
}

function entriesOf(
  agents: readonly MockAgent[],
  configs: readonly StoredAgentConfig[]
): SupportedAcpAgentEntry[] {
  return agents.map((a) => ({
    id: a.id,
    configId: configIdOf(a.id),
    agent: { id: a.id, name: a.name, version: '1.0.0', description: '', distribution: {} },
    config: configs.find((c) => c.id === configIdOf(a.id)) ?? null,
    status: a.configured ? 'ready' : 'install-required',
    install: null,
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null
  }))
}

export const MOCK_AGENT_CONFIGS: StoredAgentConfig[] = configsOf(AGENTS)
export const MOCK_ENTRIES: SupportedAcpAgentEntry[] = entriesOf(AGENTS, MOCK_AGENT_CONFIGS)

const MANY_AGENTS: MockAgent[] = [...AGENTS, ...EXTRA_AGENTS]
const MANY_CONFIGS = configsOf(MANY_AGENTS)
const MANY_ENTRIES = entriesOf(MANY_AGENTS, MANY_CONFIGS)

const MODEL_OPTION_ID = 'model'

function modelOptionFor(agent: MockAgent, current: string): SessionConfigOption {
  return {
    id: MODEL_OPTION_ID,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: agent.models.map(({ value, name, description }) => ({ value, name, description }))
  }
}

/**
 * Seed the options cache so other agents' tabs and search show their lists
 * without starting anything. Idempotent: canvas previews call it on render.
 */
export function seedMockCatalogs(): void {
  const cache = useAcpStore.getState().agentOptionsCache ?? {}
  if (cache[configIdOf('claude-acp')]) return
  const next = { ...cache }
  for (const agent of MANY_AGENTS) {
    if (!agent.configured) continue
    next[configIdOf(agent.id)] = {
      models: null,
      modes: null,
      configOptions: [modelOptionFor(agent, agent.models[0].value)],
      updatedAt: 0
    }
  }
  useAcpStore.setState({ agentOptionsCache: next })
}

export interface MockSelectorState {
  draft: DraftSelector
  agentTemplateId: string
  /** Props the panel takes, wired to the mock state. */
  modelOption: SessionConfigOption | null
  modelValue: string | undefined
  onPickModel: (value: string) => void
  thoughtLevel: SessionConfigOption | null
  effortValue: string | undefined
  onEffort: (value: string) => void
  fastMode: SessionConfigOption | null
  fastOn: boolean
  onToggleFast: (() => void) | null
  genericOptions: SessionConfigOption[]
  agentConfigId: string
  onSetConfig: (configId: string, valueId: string | boolean) => void
}

export const MOCK_DEFAULT_MODEL = 'claude-4.7-opus-thinking'
/** A model whose context option carries 256K | 500K. */
export const MOCK_NARROW_CONTEXT_MODEL = 'gpt-5.4-codex'

/**
 * One selector's mock state: the launcher (`draft`) path, so picking another
 * agent's tab selects that agent and picks land immediately.
 */
export function useMockSelector(
  key: string,
  initialModel = MOCK_DEFAULT_MODEL,
  { manyAgents = false }: { manyAgents?: boolean } = {}
): MockSelectorState {
  seedMockCatalogs()
  const agents = manyAgents ? MANY_AGENTS : AGENTS
  const agentConfigs = manyAgents ? MANY_CONFIGS : MOCK_AGENT_CONFIGS
  const entries = manyAgents ? MANY_ENTRIES : MOCK_ENTRIES
  const [agentId, setAgentId] = useState('cursor')
  const [models, setModels] = useState<Record<string, string>>({ cursor: initialModel })
  /** Option values keyed `${agentId}:${optionId}`. */
  const [values, setValues] = useState<Record<string, string>>({})

  const agent = agents.find((a) => a.id === agentId) ?? agents[0]
  const modelValue = models[agent.id] ?? agent.models[0]?.value
  const model = agent.models.find((m) => m.value === modelValue)

  const savedValue = useCallback(
    (optionId: string, choices: Array<{ value: string }>, fallback: string): string => {
      const saved = values[`${agentId}:${optionId}`]
      return saved && choices.some((c) => c.value === saved) ? saved : fallback
    },
    [agentId, values]
  )

  const thoughtLevel = useMemo<SessionConfigOption | null>(() => {
    if (!model?.effort) return null
    return {
      id: 'thought_level',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: savedValue('thought_level', EFFORT_VALUES, 'high'),
      options: EFFORT_VALUES
    }
  }, [model, savedValue])

  const fastMode = useMemo<SessionConfigOption | null>(() => {
    if (!model?.fast) return null
    const choices = [
      { value: 'off', name: 'Off' },
      { value: 'on', name: 'On' }
    ]
    return {
      id: 'fast',
      name: 'Fast',
      category: 'model_config',
      type: 'select',
      currentValue: savedValue('fast', choices, 'off'),
      options: choices
    }
  }, [model, savedValue])

  const genericOptions = useMemo<SessionConfigOption[]>(() => {
    if (!model?.context) return []
    const choices = CONTEXT_VALUES[model.context]
    return [
      {
        id: 'context',
        name: 'Context',
        category: 'model_config',
        type: 'select',
        currentValue: savedValue('context', choices, choices[0].value),
        options: choices
      }
    ]
  }, [model, savedValue])

  const setValue = useCallback(
    (optionId: string, value: string) =>
      setValues((v) => ({ ...v, [`${agentId}:${optionId}`]: value })),
    [agentId]
  )

  const source = useMemo<SelectorSource>(
    () => ({
      kind: 'draft',
      key: key,
      agentConfigs,
      entries,
      currentConfigId: configIdOf(agentId),
      armedConfigId: null,
      blocked: false,
      turnBusy: false,
      installingConfigId: null,
      install: () => {},
      workspace: { cwd: '/mock/project', projectId: 'mock' },
      liveCatalog: null,
      pickCurrentModel: (_catalog, value) => setModels((m) => ({ ...m, [agentId]: value })),
      pickOtherModel: (configId, pick) => {
        const id = configId.replace('acp-registry:', '')
        setAgentId(id)
        setModels((m) => ({ ...m, [id]: pick.modelId }))
      },
      cancelThenSwitch: async () => {},
      selectAgent: (tab) => {
        if (tab.configId) setAgentId(tab.configId.replace('acp-registry:', ''))
      },
      modelStatus: null,
      updateAgentIds: new Set(['codex-acp'])
    }),
    [key, agentId, agentConfigs, entries]
  )

  const fastOn = fastMode?.currentValue === 'on'
  return {
    draft: { source, agentName: agent.name },
    agentTemplateId: agent.id,
    modelOption: agent.models.length ? modelOptionFor(agent, modelValue) : null,
    modelValue,
    onPickModel: (value) => setModels((m) => ({ ...m, [agentId]: value })),
    thoughtLevel,
    effortValue: thoughtLevel ? String(thoughtLevel.currentValue) : undefined,
    onEffort: (value) => setValue('thought_level', value),
    fastMode,
    fastOn,
    onToggleFast: fastMode ? () => setValue('fast', fastOn ? 'off' : 'on') : null,
    genericOptions,
    agentConfigId: configIdOf(agentId),
    // The app's model write comes back as the model option's currentValue. Commit
    // it the same way here: AgentModelSelector shows its optimistic pick until the
    // committed value matches, so a write that never lands pins the pill to it.
    onSetConfig: (configId, value) => {
      if (typeof value !== 'string') return
      if (configId === MODEL_OPTION_ID) setModels((m) => ({ ...m, [agentId]: value }))
      else setValue(configId, value)
    }
  }
}
