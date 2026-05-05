export const XTERM_MIGRATION_CANARY_ENV = 'VITE_XTERM_MIGRATION_CANARY'

export type XtermMigrationCanaryMode = 'off' | 'xterm-6.1'

const XTERM_6_1_CANARY_VALUES = new Set(['xterm-6.1', 'true', '1', 'on'])

export function getXtermMigrationCanaryMode(
  value: string | undefined = import.meta.env.VITE_XTERM_MIGRATION_CANARY,
): XtermMigrationCanaryMode {
  if (!value) {
    return 'off'
  }

  const normalized = value.trim().toLowerCase()
  return XTERM_6_1_CANARY_VALUES.has(normalized) ? 'xterm-6.1' : 'off'
}

export function isXtermMigrationCanaryEnabled(
  value: string | undefined = import.meta.env.VITE_XTERM_MIGRATION_CANARY,
): boolean {
  return getXtermMigrationCanaryMode(value) === 'xterm-6.1'
}

export function getXtermMigrationDefaultPath(): 'xterm-5.5' {
  return 'xterm-5.5'
}
