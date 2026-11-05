import type { DetectedShells } from '@shared/types/ipc.types'
import type { SettingsSelectOption } from '@/components/settings/SettingsSelect'

/** Radix Select reserves the empty string; "no shell chosen" needs its own value. */
const NO_SHELL_VALUE = '__system_default__'

/** Stored value may be a name or a path; select the matching detected shell's path. */
export function shellSelectValue(stored: string, availableShells: DetectedShells | null): string {
  if (!stored) return NO_SHELL_VALUE
  if (stored.includes('\\') || stored.includes('/')) return stored
  const match = availableShells?.available.find((shell) => {
    if (shell.name === stored) return true
    return shell.path.split(/[\\/]/).pop() === stored
  })
  return match?.path ?? stored
}

/**
 * The fallback option first, then every detected shell. A stored shell that
 * detection did not find stays in the menu so the select can show it.
 */
export function shellSelectOptions(
  value: string,
  availableShells: DetectedShells | null,
  fallbackLabel: string
): SettingsSelectOption[] {
  const options = [
    { value: NO_SHELL_VALUE, label: fallbackLabel },
    ...(availableShells?.available ?? []).map((shell) => ({
      value: shell.path,
      label: shell.displayName
    }))
  ]
  if (!options.some((option) => option.value === value)) {
    options.push({ value, label: value })
  }
  return options
}

/** The value to store for a select choice: the fallback option stores ''. */
export function shellFromSelectValue(value: string): string {
  return value === NO_SHELL_VALUE ? '' : value
}
