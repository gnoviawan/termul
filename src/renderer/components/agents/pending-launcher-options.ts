import type { SessionConfigOption, SessionModelState, SessionModeState } from '@/lib/acp-api'

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
    Object.keys(pending.configValues).length === 0
      ? input.configOptions
      : input.configOptions.map((option) => {
          const next = pending.configValues[option.id]
          return next == null ? option : { ...option, currentValue: next }
        })
  return { models, modes, configOptions }
}
