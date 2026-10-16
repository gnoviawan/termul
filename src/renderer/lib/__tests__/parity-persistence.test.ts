/**
 * Persistence parity rows for the shell-layout record (shell revamp story 12).
 *
 * Sibling of `parity-checklist.test.ts` (kept separate so concurrent stories do
 * not conflict). The record must reach durable storage only through the
 * `persistenceApi` facade: one host-store facade on every surface (the desktop
 * reaches it over the Channel carrier), so all surfaces behave alike.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { describe, expect, it } from 'vitest'

const LIB_DIR = join(__dirname, '..')
const RENDERER_DIR = join(LIB_DIR, '..')

const read = (path: string): string => {
  expect(existsSync(path), `${path} should exist`).toBe(true)
  return readFileSync(path, 'utf-8')
}

const SHELL_LAYOUT_SOURCES = {
  store: join(RENDERER_DIR, 'stores', 'shell-layout-store.ts'),
  record: join(LIB_DIR, 'shell-layout-record.ts'),
  migration: join(LIB_DIR, 'shell-layout-migration.ts'),
  hook: join(RENDERER_DIR, 'hooks', 'use-shell-layout-hydration.ts')
}

describe('shell-layout persistence parity', () => {
  it('declares its own key in PersistenceKeys', () => {
    expect(PersistenceKeys.shellLayout).toBe('shell-layout')
    expect(read(join(RENDERER_DIR, '..', 'shared', 'types', 'persistence.types.ts'))).toContain(
      "shellLayout: 'shell-layout'"
    )
  })

  it('reads, writes, debounces and deletes only through persistenceApi', () => {
    const store = read(SHELL_LAYOUT_SOURCES.store)
    expect(store).toMatch(/import \{[^}]*persistenceApi[^}]*\} from '@\/lib\/api'/)
    expect(store).toContain('persistenceApi.read')
    expect(store).toContain('persistenceApi.write(')
    expect(store).toMatch(/persistenceApi\s*\.writeDebounced\(/)
    expect(store).toContain('persistenceApi.delete(')
    expect(store).toContain('PersistenceKeys.shellLayout')
  })

  it('never writes browser storage, and only the migration reads the legacy keys', () => {
    for (const [name, path] of Object.entries(SHELL_LAYOUT_SOURCES)) {
      const source = read(path)
      expect(source, `${name} must not call setItem`).not.toMatch(/\bsetItem\s*\(/)
      expect(source, `${name} must not call removeItem`).not.toMatch(/\bremoveItem\s*\(/)
      expect(source, `${name} must not touch sessionStorage`).not.toContain('sessionStorage')
      if (name !== 'migration') {
        expect(source, `${name} must not read localStorage`).not.toContain('localStorage')
      }
    }
    expect(read(SHELL_LAYOUT_SOURCES.migration)).toMatch(/localStorage\?\.getItem/)
  })

  it('keeps the legacy layout keys read-only: resize code no longer touches localStorage', () => {
    const migration = read(SHELL_LAYOUT_SOURCES.migration)
    expect(migration).toContain("'termul:file-explorer-width'")
    expect(migration).toContain("'termul-ssh-panel-height'")
    expect(
      existsSync(join(RENDERER_DIR, 'components', 'file-explorer', 'use-explorer-resize.ts'))
    ).toBe(false)
    const sshSection = read(join(RENDERER_DIR, 'components', 'sidebar', 'ssh-section.tsx'))
    expect(sshSection).not.toContain('localStorage')
    expect(sshSection).toContain('setSshSectionHeight')
  })

  it('mounts the hydration hook on both renderer roots', () => {
    for (const root of ['App.tsx', 'TauriApp.tsx']) {
      const source = read(join(RENDERER_DIR, root))
      expect(source, `${root} imports the hook`).toContain(
        "from './hooks/use-shell-layout-hydration'"
      )
      expect(source, `${root} mounts the hook`).toContain('useShellLayoutHydration()')
    }
  })
})
