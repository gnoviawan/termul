import { describe, expect, it } from 'vitest'
import {
  XTERM_MIGRATION_CANARY_ENV,
  getXtermMigrationCanaryMode,
  getXtermMigrationDefaultPath,
  isXtermMigrationCanaryEnabled,
} from './xterm-migration'

describe('xterm-migration', () => {
  it('keeps the canary off by default', () => {
    expect(getXtermMigrationCanaryMode(undefined)).toBe('off')
    expect(isXtermMigrationCanaryEnabled(undefined)).toBe(false)
  })

  it('recognizes explicit xterm 6.1 canary values', () => {
    expect(getXtermMigrationCanaryMode('xterm-6.1')).toBe('xterm-6.1')
    expect(getXtermMigrationCanaryMode('true')).toBe('xterm-6.1')
    expect(getXtermMigrationCanaryMode('1')).toBe('xterm-6.1')
    expect(getXtermMigrationCanaryMode('on')).toBe('xterm-6.1')
    expect(isXtermMigrationCanaryEnabled('xterm-6.1')).toBe(true)
  })

  it('treats unknown values as off', () => {
    expect(getXtermMigrationCanaryMode('disabled')).toBe('off')
    expect(isXtermMigrationCanaryEnabled('disabled')).toBe(false)
  })

  it('keeps the production default path on xterm 5.5', () => {
    expect(getXtermMigrationDefaultPath()).toBe('xterm-5.5')
    expect(XTERM_MIGRATION_CANARY_ENV).toBe('VITE_XTERM_MIGRATION_CANARY')
  })
})
