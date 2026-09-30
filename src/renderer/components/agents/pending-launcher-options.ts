import type { SessionConfigOption, SessionModelState, SessionModeState } from '@/lib/acp-api'
import {
  MODEL_CATEGORY,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from '@/components/chat/chat-input-bar-config'

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
  const usable = input.configOptions.filter((o) => o.options.length > 0)
  const { model, thoughtLevel, rest } = partitionConfigOptions(usable)
  // A `modes` object with an empty `availableModes` is not a usable mode
  // API: the Agent chip is hidden and mode-category config options stay
  // displayed (so they belong in `configValues`, not `modeId`).
  const modes =
    input.modes && input.modes.availableModes.length > 0 ? input.modes : null
  const configValues: Record<string, string> = {}
  for (const option of [
    ...(model ? [model] : []),
    ...(thoughtLevel ? [thoughtLevel] : []),
    ...filterDuplicateModeConfigOptions(rest, modes)
  ]) {
    if (option.currentValue) configValues[option.id] = option.currentValue
  }
  const modelOption = resolveModelOption(model, input.models).option
  return {
    modelId: modelOption?.currentValue || undefined,
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
          const next =
            pending.configValues[option.id] ??
            (option.category === MODEL_CATEGORY &&
            pending.modelId != null &&
            option.options.some((o) => o.value === pending.modelId)
              ? pending.modelId
              : undefined)
          return next == null ? option : { ...option, currentValue: next }
        })
  return { models, modes, configOptions }
}
