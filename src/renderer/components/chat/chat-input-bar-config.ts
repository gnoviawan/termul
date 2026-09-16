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

/** Config categories that are promoted to a single dedicated control; only
 *  the agent's FIRST option of each category is surfaced (#444). */
const SINGLETON_CATEGORIES: Record<string, true> = {
  [MODEL_CATEGORY]: true,
  [THOUGHT_LEVEL_CATEGORY]: true
}

/**
 * First-wins dedupe for the promoted singleton categories (`model`,
 * `thought_level`): keep the first option of each category and drop the rest.
 * Agents such as pi ACP can advertise several `thought_level` options; without
 * this, every duplicate after the promoted one leaks into the generic chip row
 * and the `/` slash menu, rendering a second "Thinking: …" control (#444).
 */
export function dropDuplicateSingletonConfigOptions(
  options: SessionConfigOption[]
): SessionConfigOption[] {
  const seen = new Set<string>()
  const result: SessionConfigOption[] = []
  for (const option of options) {
    if (option.category && option.category in SINGLETON_CATEGORIES) {
      if (seen.has(option.category)) continue
      seen.add(option.category)
    }
    result.push(option)
  }
  return result
}

/**
 * Split usable config options into promoted `model` / `thought_level` options
 * (first match wins for each) and the rest, preserving the rest's original
 * order. Options with an unknown/other category fall through to `rest` and
 * render as plain chips. Later options in a promoted category are dropped
 * entirely — a promoted control must be the ONLY control for its category
 * (#444).
 */
export function partitionConfigOptions(options: SessionConfigOption[]): PartitionedConfigOptions {
  let model: SessionConfigOption | null = null
  let thoughtLevel: SessionConfigOption | null = null
  const rest: SessionConfigOption[] = []
  for (const option of options) {
    if (option.category === MODEL_CATEGORY) {
      if (model === null) model = option
    } else if (option.category === THOUGHT_LEVEL_CATEGORY) {
      if (thoughtLevel === null) thoughtLevel = option
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

const ON_TOKEN = /^(on|true|enabled|1)$/i
const OFF_TOKEN = /^(off|false|disabled|0)$/i

function isOnOffToken(value: string): boolean {
  return ON_TOKEN.test(value) || OFF_TOKEN.test(value)
}

/** True when an option is a two-value On/Off (or true/false) switch. */
export function isBinaryOnOffOption(option: SessionConfigOption): boolean {
  if (option.options.length !== 2) return false
  return option.options.every((entry) => isOnOffToken(entry.value) || isOnOffToken(entry.name))
}

/**
 * Detect the Cursor-style Fast Mode switch advertised as a generic select with
 * On/Off values. Matched by id/name/category containing "fast".
 */
export function isFastModeOption(option: SessionConfigOption): boolean {
  const haystack = `${option.id} ${option.name} ${option.category ?? ''}`.toLowerCase()
  return haystack.includes('fast') && isBinaryOnOffOption(option)
}

function entryIsOn(entry: SessionConfigOption['options'][number]): boolean {
  return ON_TOKEN.test(entry.value) || ON_TOKEN.test(entry.name)
}

/** Whether the option's current value is the On side of a Fast Mode switch. */
export function isFastModeEnabled(
  option: SessionConfigOption,
  currentValue: string = option.currentValue
): boolean {
  const current = option.options.find((entry) => entry.value === currentValue)
  if (!current) return false
  return entryIsOn(current)
}

/** Opposite value for a Fast Mode toggle click. */
export function oppositeFastModeValue(
  option: SessionConfigOption,
  currentValue: string = option.currentValue
): string | null {
  const other = option.options.find((entry) => entry.value !== currentValue)
  return other?.value ?? null
}

/**
 * Pull the first Fast Mode switch out of a generic options list so it can
 * render as an icon toggle instead of a labeled select pill.
 */
export function extractFastModeOption(options: SessionConfigOption[]): {
  fastMode: SessionConfigOption | null
  rest: SessionConfigOption[]
} {
  const index = options.findIndex(isFastModeOption)
  if (index < 0) return { fastMode: null, rest: options }
  const fastMode = options[index] ?? null
  const rest = options.filter((_, i) => i !== index)
  return { fastMode, rest }
}
