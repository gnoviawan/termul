/**
 * Shared zustand store seed/reset helpers for tests that exercise the REAL
 * stores (i.e. do not `vi.mock` them).
 *
 * Vitest mocks apply module-graph-wide: in a test file that mocks
 * `@/stores/terminal-store`, this module sees the mock too — so only use
 * these helpers from suites that keep the real store.
 */
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { Project, Terminal } from '@/types/project'
import { type AppSettings, DEFAULT_APP_SETTINGS } from '@/types/settings'

/** `Project` record for seeding `useProjectStore`. */
export function mockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    color: 'blue',
    ...overrides
  }
}

/** Empty `useTerminalStore` slice — the common afterEach/beforeEach reset. */
export function resetTerminalStore(): void {
  useTerminalStore.setState({
    terminals: [],
    activeTerminalId: '',
    ptyIdIndex: new Map()
  })
}

/**
 * Seed `useTerminalStore.terminals` (+ optional active id). `ptyIdIndex`
 * defaults to the index derived from each terminal's `ptyId`; pass an
 * explicit map when the scenario needs index entries that no terminal
 * carries (or vice versa).
 *
 * Merge semantics match a hand-written `setState`: `activeTerminalId` is
 * only set when explicitly provided, so partial updates keep the previous
 * value just like `setState({ terminals })` does.
 */
export function seedTerminalStore(
  terminals: Terminal[],
  options: { activeTerminalId?: string; ptyIdIndex?: Map<string, string> } = {}
): void {
  const ptyIdIndex =
    options.ptyIdIndex ??
    new Map(terminals.flatMap((t): Array<[string, string]> => (t.ptyId ? [[t.ptyId, t.id]] : [])))
  useTerminalStore.setState({
    terminals,
    ptyIdIndex,
    ...(options.activeTerminalId !== undefined
      ? { activeTerminalId: options.activeTerminalId }
      : {})
  })
}

/** Empty `useProjectStore` slice. */
export function resetProjectStore(): void {
  useProjectStore.setState({ projects: [], activeProjectId: '' })
}

/** Seed `useProjectStore.projects` (+ optional active id). */
export function seedProjectStore(projects: Project[], activeProjectId = ''): void {
  useProjectStore.setState({ projects, activeProjectId })
}

/** `useAppSettingsStore` back to defaults. */
export function resetAppSettingsStore(isLoaded = false): void {
  useAppSettingsStore.setState({
    settings: { ...DEFAULT_APP_SETTINGS },
    isLoaded
  })
}

/** `useAppSettingsStore` seeded with `DEFAULT_APP_SETTINGS` plus overrides. */
export function seedAppSettingsStore(settings: Partial<AppSettings> = {}, isLoaded = true): void {
  useAppSettingsStore.setState({
    settings: { ...DEFAULT_APP_SETTINGS, ...settings },
    isLoaded
  })
}
