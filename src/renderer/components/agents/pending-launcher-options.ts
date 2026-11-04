import type { PersistedComposerOptions } from '@shared/types/persistence.types'
import {
  filterDuplicateModeConfigOptions,
  flattenConfigOptionValues,
  isUsableConfigOption,
  MODEL_CATEGORY,
  partitionConfigOptions,
  resolveModelOption,
  storedConfigValue,
  wireConfigValue
} from '@/components/chat/chat-input-bar-config'
import type { SessionConfigOption, SessionModelState, SessionModeState } from '@/lib/acp-api'
import {
  agentWideValues,
  type OptionValues,
  savedAgentWideValues,
  savedModelValues,
  unscopedValues
} from '@/stores/acp-store/composer-options'

/** Launcher selections made against cached options before a live session exists. */
export type PendingLauncherOptions = {
  modelId?: string
  modeId?: string
  configValues: Record<string, string>
}

export function emptyPendingLauncherOptions(): PendingLauncherOptions {
  return { configValues: {} }
}

export function hasPendingLauncherOptions(pending: PendingLauncherOptions): boolean {
  return Boolean(pending.modelId || pending.modeId || Object.keys(pending.configValues).length > 0)
}

/**
 * Build the launch `pending` payload from the effective DISPLAYED option
 * snapshot — the models/modes/config state the launcher chips render,
 * including pending overlays already applied to a warm session. Unlike the
 * unflushed `pendingOptions` queue (drained once picks are applied live),
 * this captures what the user sees: launches that bind a different session
 * object (worktree launches always create a fresh one) still re-deliver the
 * displayed selections, not `session/new` defaults.
 *
 * Shape rules mirror the chips:
 * - `modeId` ← `modes.currentModeId` (the Agent chip owns mode when the
 *   native modes API is advertised; mode-category config options are then
 *   suppressed from `configValues` via `filterDuplicateModeConfigOptions`).
 * - `modelId` ← `resolveModelOption` precedence (model config option wins
 *   over the native `models` projection).
 * - `configValues` ← every advertised option's `currentValue` (the model
 *   option included — `applyPendingLauncherOptions` dedupes it against the
 *   model application path).
 */
export function optionsToPending(input: {
  models: SessionModelState | null | undefined
  modes: SessionModeState | null | undefined
  configOptions: SessionConfigOption[]
}): PendingLauncherOptions {
  // Mirror the chip pipeline exactly — only DISPLAYED options may reach the
  // launch payload: `options.length === 0` entries are never rendered
  // (`usableConfigOptions`), and only the first option of each promoted
  // singleton category is surfaced (#444). Shipping hidden values would fire
  // `set_config_option` calls for controls the user cannot see.
  const usable = input.configOptions.filter(isUsableConfigOption)
  const { model, thoughtLevel, rest } = partitionConfigOptions(usable)
  // A `modes` object with an empty `availableModes` is not a usable mode
  // API: the Agent chip is hidden and mode-category config options stay
  // displayed (so they belong in `configValues`, not `modeId`).
  const modes = input.modes && input.modes.availableModes.length > 0 ? input.modes : null
  const configValues: Record<string, string> = {}
  for (const option of [
    ...(model ? [model] : []),
    ...(thoughtLevel ? [thoughtLevel] : []),
    ...filterDuplicateModeConfigOptions(rest, modes)
  ]) {
    const stored = storedConfigValue(option)
    if (stored) configValues[option.id] = stored
  }
  const modelOption = resolveModelOption(model, input.models).option
  return {
    modelId:
      typeof modelOption?.currentValue === 'string'
        ? modelOption.currentValue || undefined
        : undefined,
    modeId: modes?.currentModeId || undefined,
    configValues
  }
}

/** Paint pending selections on top of live or cached option state. */
export function overlayPendingLauncherOptions(input: {
  models: SessionModelState | null | undefined
  modes: SessionModeState | null | undefined
  configOptions: SessionConfigOption[]
  pending: PendingLauncherOptions
}): {
  models: SessionModelState | null
  modes: SessionModeState | null
  configOptions: SessionConfigOption[]
} {
  const { pending } = input
  const models =
    input.models == null
      ? null
      : pending.modelId
        ? { ...input.models, currentModelId: pending.modelId }
        : input.models
  const modes =
    input.modes == null
      ? null
      : pending.modeId
        ? { ...input.modes, currentModeId: pending.modeId }
        : input.modes
  const configOptions =
    Object.keys(pending.configValues).length === 0 && pending.modelId == null
      ? input.configOptions
      : input.configOptions.map((option) => {
          // `pending.modelId` is the DISPLAYED model pick — when the target
          // advertises its model as a config option (no native models
          // state), paint it there too or the chip keeps the old value.
          const stored = pending.configValues[option.id]
          const fromConfig = stored == null ? null : wireConfigValue(option, stored)
          const fromModel =
            option.category === MODEL_CATEGORY &&
            pending.modelId != null &&
            flattenConfigOptionValues(option).some((entry) => entry.value === pending.modelId)
              ? pending.modelId
              : undefined
          const next = fromConfig ?? fromModel
          return next == null ? option : { ...option, currentValue: next }
        })
  return { models, modes, configOptions }
}

/**
 * Launcher picks after a model pick: the new model with its own values. The
 * last model's scoped values do not carry over (a model never tuned gets the
 * agent's defaults); mode-category values stay.
 */
export function pendingWithModel(
  prev: PendingLauncherOptions,
  modelId: string,
  values: OptionValues,
  modelConfigId: string | null,
  options: readonly SessionConfigOption[]
): PendingLauncherOptions {
  const configValues = { ...agentWideValues(prev.configValues, options), ...values }
  if (modelConfigId) configValues[modelConfigId] = modelId
  return { ...prev, modelId, configValues }
}

/** A model picked together with its agent in the selector. */
export interface LauncherModelPick {
  modelId: string
  modelConfigId: string | null
  values?: OptionValues
}

/**
 * Seed the launcher from a saved record: the model (a pick made with its
 * agent wins), then that model's values and the agent-wide ones, then the
 * mode. Values are checked only against options advertised while that same
 * model is shown; otherwise (a cold start, another model on screen) they are
 * kept, and the live session later skips what it does not advertise.
 */
export function restoredLauncherOptions(input: {
  saved: PersistedComposerOptions
  pick: LauncherModelPick | null
  models: SessionModelState | null | undefined
  modes: SessionModeState | null | undefined
  configOptions: SessionConfigOption[]
  /** Called for each saved selection the loaded options no longer offer. */
  onDrop: (what: string) => void
}): PendingLauncherOptions {
  const { saved, pick, configOptions, onDrop } = input
  const { option: modelOption, source: modelSource } = resolveModelOption(
    partitionConfigOptions(configOptions).model,
    input.models
  )
  let modelId = pick?.modelId ?? saved.modelId
  if (
    !pick &&
    modelId &&
    modelOption &&
    !flattenConfigOptionValues(modelOption).some((o) => o.value === modelId)
  ) {
    onDrop('model')
    modelId = undefined
  }
  const shownModel = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : null
  const validate = configOptions.length > 0 && (!modelId || modelId === shownModel)
  const values = {
    ...savedAgentWideValues(saved, configOptions),
    ...(pick?.values ?? savedModelValues(saved, modelId ?? shownModel))
  }
  const configValues: OptionValues = {}
  for (const [optionId, valueId] of Object.entries(values)) {
    // Boolean options have no value list; "true" / "false" are the only stored forms.
    const option = configOptions.find((o) => o.id === optionId)
    const offered =
      !validate ||
      (option != null &&
        wireConfigValue(option, valueId) != null &&
        (option.type === 'boolean' ||
          flattenConfigOptionValues(option).some((o) => o.value === valueId)))
    if (offered) configValues[optionId] = valueId
    else onDrop(`option ${optionId}`)
  }
  // Mirror the launcher's dual-write of a model it lists through a config option.
  const modelConfigId = pick
    ? pick.modelConfigId
    : modelSource === 'config'
      ? (modelOption?.id ?? null)
      : null
  if (modelId && modelConfigId) configValues[modelConfigId] = modelId
  let modeId = saved.modeId
  if (modeId && input.modes && !input.modes.availableModes.some((m) => m.id === modeId)) {
    onDrop('mode')
    modeId = undefined
  }
  return { modelId, modeId, configValues }
}

/**
 * Merge a restore that finished after the user started picking: their picks
 * win. A model picked meanwhile keeps its own values, so only the record's
 * agent-wide values join it (on a cold start, the record's guess of them).
 */
export function mergeRestoredPending(
  prev: PendingLauncherOptions,
  restored: PendingLauncherOptions,
  saved: PersistedComposerOptions,
  options: readonly SessionConfigOption[]
): PendingLauncherOptions {
  const restoredValues =
    prev.modelId && prev.modelId !== restored.modelId
      ? savedAgentWideValues(saved, options)
      : restored.configValues
  return {
    modelId: prev.modelId ?? restored.modelId,
    modeId: prev.modeId ?? restored.modeId,
    configValues: { ...restoredValues, ...prev.configValues }
  }
}

/**
 * The launch payload: the options on screen, plus picks for options that had
 * not loaded yet (a cold start shows none, but the saved values still apply).
 * Shown scoped values (effort, Fast) belong to the model the shown options
 * came from (`base.modelId`); a launch on another model keeps only its own.
 */
export function launchPending(
  displayed: PendingLauncherOptions,
  pending: PendingLauncherOptions,
  base: { modelId: string | undefined; options: readonly SessionConfigOption[] }
): PendingLauncherOptions {
  const modelId = displayed.modelId ?? pending.modelId
  const shown =
    !modelId || base.modelId === modelId
      ? displayed.configValues
      : unscopedValues(displayed.configValues, base.options)
  return {
    modelId,
    modeId: displayed.modeId ?? pending.modeId,
    configValues: { ...pending.configValues, ...shown }
  }
}
