/**
 * Pure helpers for the input-bar config-option chip row. Kept free of
 * React/store so they can be unit-tested directly. Partitions agent-advertised
 * config options so the `model` and `thought_level` controls can be promoted
 * to dedicated chips rendered ahead of generic options
 * (issue #286).
 */
import type { SessionConfigOption, SessionModelState, SessionModeState } from '@/lib/acp-api'

/** ACP semantic category for reasoning/thinking-depth config options. */
export const THOUGHT_LEVEL_CATEGORY = 'thought_level'
/** ACP semantic category for model selection config options. */
export const MODEL_CATEGORY = 'model'
/** ACP semantic category for session mode config options. */
export const MODE_CATEGORY = 'mode'

/**
 * Categories that map to a single promoted UI control. Agents may advertise
 * multiple options with the same category; clients keep the first (ACP array
 * order) and discard the rest so the composer does not show duplicate chips
 * (issue #444).
 */
export const PROMOTED_SINGLETON_CATEGORIES = new Set<string>([
  MODEL_CATEGORY,
  THOUGHT_LEVEL_CATEGORY
])

export interface PartitionedConfigOptions {
  /** The first `model` option, if the agent advertises one. */
  model: SessionConfigOption | null
  /** The first `thought_level` option, if the agent advertises one. */
  thoughtLevel: SessionConfigOption | null
  /** All remaining options, in their original relative order. */
  rest: SessionConfigOption[]
}

export interface ResolvedModelOption {
  option: SessionConfigOption | null
  source: 'config' | 'models' | null
}

/**
 * First-wins gate for promoted singleton categories (`model`, `thought_level`).
 * Mutates `seenPromotedCategories` when accepting the first option of a
 * category. Non-singleton / uncategorized options always pass through.
 */
export function shouldAdvertiseConfigOption(
  option: Pick<SessionConfigOption, 'category'>,
  seenPromotedCategories: Set<string>
): boolean {
  const category = option.category
  if (!category || !PROMOTED_SINGLETON_CATEGORIES.has(category)) return true
  if (seenPromotedCategories.has(category)) return false
  seenPromotedCategories.add(category)
  return true
}

/**
 * Split usable config options into promoted `model` / `thought_level` options
 * (first match wins for each) and the rest, preserving the rest's original
 * order. Later options that share a promoted singleton category are discarded
 * rather than falling through to `rest`. Unknown/other categories still render
 * as plain chips.
 */
export function partitionConfigOptions(options: SessionConfigOption[]): PartitionedConfigOptions {
  let model: SessionConfigOption | null = null
  let thoughtLevel: SessionConfigOption | null = null
  const rest: SessionConfigOption[] = []
  const seenPromotedCategories = new Set<string>()
  for (const option of options) {
    if (!shouldAdvertiseConfigOption(option, seenPromotedCategories)) continue
    if (model === null && option.category === MODEL_CATEGORY) {
      model = option
    } else if (thoughtLevel === null && option.category === THOUGHT_LEVEL_CATEGORY) {
      thoughtLevel = option
    } else {
      rest.push(option)
    }
  }
  return { model, thoughtLevel, rest }
}

/**
 * ACP has two model-selection shapes in the wild: generic config options and
 * the native session model state. Prefer config options when present, then
 * synthesize a picker-compatible option from `session.models`.
 */
export function resolveModelOption(
  configModel: SessionConfigOption | null,
  models: SessionModelState | null | undefined
): ResolvedModelOption {
  if (configModel) return { option: configModel, source: 'config' }
  if (!models || models.availableModels.length === 0) return { option: null, source: null }
  return {
    source: 'models',
    option: {
      id: MODEL_CATEGORY,
      name: 'Model',
      category: MODEL_CATEGORY,
      type: 'select',
      currentValue: models.currentModelId,
      options: models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? undefined
      }))
    }
  }
}

/**
 * Some agents advertise modes both through `session.modes` and a `mode` config
 * option. When the native modes API is available, keep one Agent picker that
 * calls `session/set_mode` instead of rendering a duplicate config chip.
 */
export function filterDuplicateModeConfigOptions(
  options: SessionConfigOption[],
  modes: SessionModeState | null
): SessionConfigOption[] {
  if (!modes || modes.availableModes.length === 0) return options
  return options.filter((option) => option.category !== MODE_CATEGORY)
}
