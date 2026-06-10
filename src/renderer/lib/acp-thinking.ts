import type {
  ModelInfo,
  SessionConfigOption,
  SessionMode,
  SessionModelState,
  SessionModeState
} from '@/lib/acp-api'

export const THINKING_LEVELS_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

export type ThinkingLevel = (typeof THINKING_LEVELS_ORDER)[number]

export function getCurrentModelInfo(models: SessionModelState | null): ModelInfo | null {
  if (!models) return null
  return models.availableModels.find((m) => m.modelId === models.currentModelId) ?? null
}

/** Pi-style xhigh fallback when `thinkingLevelMap` is absent. */
export function supportsXhighFallback(model: ModelInfo): boolean {
  const id = (model.modelId.split('/').pop() ?? model.modelId).toLowerCase()
  return (
    id.includes('gpt-5.2') ||
    id.includes('gpt-5.3') ||
    id.includes('gpt-5.4') ||
    id.includes('gpt-5.5') ||
    id.includes('deepseek-v4-pro') ||
    id.includes('deepseek-v4-flash') ||
    id.includes('opus-4-6') ||
    id.includes('opus-4.6') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4.7')
  )
}

/**
 * Supported thinking level ids for a model.
 * Returns `null` when model metadata is unavailable — caller should trust agent modes.
 */
export function getSupportedThinkingLevels(model: ModelInfo | null): ThinkingLevel[] | null {
  if (!model || model.reasoning === undefined) return null
  if (!model.reasoning) return ['off']

  if (model.thinkingLevelMap) {
    return THINKING_LEVELS_ORDER.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level]
      if (mapped === null) return false
      if (level === 'xhigh') return mapped !== undefined
      return true
    })
  }

  return supportsXhighFallback(model)
    ? [...THINKING_LEVELS_ORDER]
    : THINKING_LEVELS_ORDER.filter((level) => level !== 'xhigh')
}

export function clampThinkingLevel(
  level: string,
  supported: readonly ThinkingLevel[]
): ThinkingLevel {
  if (supported.includes(level as ThinkingLevel)) return level as ThinkingLevel
  const requestedIndex = THINKING_LEVELS_ORDER.indexOf(level as ThinkingLevel)
  if (requestedIndex === -1) return supported[0] ?? 'off'
  for (let i = requestedIndex; i < THINKING_LEVELS_ORDER.length; i++) {
    const candidate = THINKING_LEVELS_ORDER[i]
    if (supported.includes(candidate)) return candidate
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS_ORDER[i]
    if (supported.includes(candidate)) return candidate
  }
  return supported[0] ?? 'off'
}

function modeLabel(id: string, modes: SessionModeState): SessionMode {
  const existing = modes.availableModes.find((m) => m.id === id)
  return existing ?? { id, name: `Thinking: ${id}`, description: null }
}

/**
 * Model-aware thinking modes for the UI.
 * Returns `null` when the thinking chip should be hidden (non-reasoning models).
 */
export function resolveSessionModes(
  modes: SessionModeState | null,
  models: SessionModelState | null
): SessionModeState | null {
  if (!modes || modes.availableModes.length === 0) return null

  const model = getCurrentModelInfo(models)
  const supported = getSupportedThinkingLevels(model)

  if (supported === null) {
    if (modes.availableModes.length === 1 && modes.availableModes[0]?.id === 'off') return null
    return modes
  }

  if (supported.length === 1 && supported[0] === 'off') return null

  const availableModes = supported.map((id) => modeLabel(id, modes))
  const currentModeId = supported.includes(modes.currentModeId as ThinkingLevel)
    ? modes.currentModeId
    : clampThinkingLevel(modes.currentModeId, supported)

  return { currentModeId, availableModes }
}

/** Whether reasoning/thinking blocks should be shown in the chat timeline. */
export function isThinkingVisible(
  modes: SessionModeState | null,
  models: SessionModelState | null,
  configOptions: SessionConfigOption[] = []
): boolean {
  const thoughtLevel = configOptions.find((o) => o.category === 'thought_level')
  if (thoughtLevel) {
    const value = thoughtLevel.currentValue
    return value !== 'off' && value !== ''
  }
  if (!modes) return true
  const resolved = resolveSessionModes(modes, models)
  if (!resolved) return false
  return resolved.currentModeId !== 'off'
}
