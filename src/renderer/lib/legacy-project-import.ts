/**
 * One-shot desktop migration of the renderer's old `projects` record (the
 * plugin-store key that used to own the project list) to the host registry.
 *
 * On the first desktop launch after the upgrade the old record is split in two:
 * the list (id, name, colour, path, archived, default) goes to the host through
 * `project_registry_import`, and everything the host does not carry (icon, git
 * state, worktrees, shell, env var placeholders, groups, order, the active
 * project) goes to this device's `project-prefs` / `active-project` keys. The
 * old key is deleted only after the host acknowledged AND the prefs are saved,
 * so an interrupted run is retried on the next launch. A host that already
 * imported replies `imported: false`: it ignores the list, and the split and
 * the delete still finish. Never runs on web.
 *
 * Secret env var values stay where they were (secure storage); the record only
 * ever held the `[REDACTED]` placeholder.
 */

import type { ProjectIcon } from '@shared/types/ipc.types'
import {
  type PersistedEnvVariable,
  type PersistedProjectGroup,
  type PersistedProjectPrefs,
  type PersistedWorktree,
  PersistenceKeys,
  type ProjectPrefsRecord
} from '@shared/types/persistence.types'
import type { ProjectSummary } from '@shared/types/web-projects.types'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { projectRegistryImport } from '@/lib/tauri-remote-api'
import { isTauriContext } from '@/lib/tauri-runtime'

/** The plugin-store key the old project record lived under. */
export const LEGACY_PROJECTS_KEY = 'projects'

/** One project of the old record (private: nothing else reads this shape). */
interface LegacyProject {
  id: string
  name: string
  color: string
  path?: string
  isArchived?: boolean
  gitBranch?: string
  defaultShell?: string
  envVars?: PersistedEnvVariable[]
  worktrees?: PersistedWorktree[]
  /** The host default the old record flagged. */
  isDefault?: boolean
  isGitRepo?: boolean
  icon?: ProjectIcon
}

/** The old record. */
interface LegacyProjectsRecord {
  projects: LegacyProject[]
  groups?: PersistedProjectGroup[]
  activeProjectId?: string
}

/** How an import attempt ended. */
export type LegacyImportOutcome = 'imported' | 'skipped' | 'failed'

function isLegacyRecord(data: unknown): data is LegacyProjectsRecord {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { projects?: unknown }).projects)
  )
}

function isLegacyProject(value: unknown): value is LegacyProject {
  if (typeof value !== 'object' || value === null) return false
  const project = value as Partial<LegacyProject>
  return (
    typeof project.id === 'string' &&
    project.id !== '' &&
    typeof project.name === 'string' &&
    typeof project.color === 'string'
  )
}

function toSummary(project: LegacyProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    path: project.path ?? null,
    isArchived: project.isArchived ?? false,
    isDefault: project.isDefault === true
  }
}

function toPrefs(project: LegacyProject): PersistedProjectPrefs {
  const prefs: PersistedProjectPrefs = {}
  if (project.gitBranch !== undefined) prefs.gitBranch = project.gitBranch
  if (project.defaultShell !== undefined) prefs.defaultShell = project.defaultShell
  if (project.envVars && project.envVars.length > 0) prefs.envVars = project.envVars
  if (project.worktrees) prefs.worktrees = project.worktrees
  if (project.isGitRepo !== undefined) prefs.isGitRepo = project.isGitRepo
  if (project.icon) prefs.icon = project.icon
  return prefs
}

/** The prefs record for the old projects, never overwriting what the device already saved. */
function mergePrefs(
  existing: ProjectPrefsRecord | null,
  legacy: LegacyProject[],
  groups: PersistedProjectGroup[]
): ProjectPrefsRecord {
  const projects: Record<string, PersistedProjectPrefs> = { ...(existing?.projects ?? {}) }
  for (const project of legacy) {
    projects[project.id] ??= toPrefs(project)
  }
  const order = existing?.order ?? []
  return {
    projects,
    groups: existing && existing.groups.length > 0 ? existing.groups : groups,
    order: order.length > 0 ? order : legacy.map((project) => project.id),
    updatedAt: new Date().toISOString()
  }
}

async function fail(step: string, detail: string): Promise<LegacyImportOutcome> {
  void logFrontendError({
    level: 'warn',
    source: 'legacy-project-import',
    message: `${step} failed, the old project record is kept for the next launch: ${detail}`
  })
  return 'failed'
}

/**
 * Run the migration when the old `projects` record exists (desktop only).
 * `beforeDelete` runs once everything is saved and before the old key goes:
 * the shell-layout migration still reads worktree picks from that record.
 */
export async function importLegacyProjects(
  beforeDelete?: () => Promise<void>
): Promise<LegacyImportOutcome> {
  if (!isTauriContext()) return 'skipped'

  const stored = await persistenceApi.read<unknown>(LEGACY_PROJECTS_KEY)
  if (!stored.success) {
    // An absent key is the normal case after the first run; anything else
    // is a read problem worth a trace.
    if (stored.code !== 'KEY_NOT_FOUND') return fail('reading the old project record', stored.error)
    return 'skipped'
  }
  if (!isLegacyRecord(stored.data)) return 'skipped'

  const record = stored.data
  const legacy = record.projects.filter(isLegacyProject)
  const defaultProjectId = legacy.find((project) => project.isDefault === true)?.id ?? null

  const acknowledged = await projectRegistryImport(legacy.map(toSummary), defaultProjectId)
  if (!acknowledged.success) return fail('the host import', acknowledged.error)

  // A record that exists but cannot be read must not be replaced by one built
  // from the old data alone: stop and retry on the next launch.
  const existing = await persistenceApi.read<ProjectPrefsRecord>(PersistenceKeys.projectPrefs)
  if (!existing.success && existing.code !== 'KEY_NOT_FOUND') {
    return fail('reading the saved project prefs', existing.error)
  }
  const merged = mergePrefs(existing.success ? existing.data : null, legacy, record.groups ?? [])
  const savedPrefs = await persistenceApi.write(PersistenceKeys.projectPrefs, merged)
  if (!savedPrefs.success) return fail('saving the project prefs', savedPrefs.error)

  // The device kept its selection inside the old record: carry it over unless
  // the device already has one of its own.
  const activeProjectId = record.activeProjectId
  if (activeProjectId && legacy.some((project) => project.id === activeProjectId)) {
    const savedActive = await persistenceApi.read<string>(PersistenceKeys.activeProject)
    if (!savedActive.success) {
      if (savedActive.code !== 'KEY_NOT_FOUND') {
        return fail('reading the saved active project', savedActive.error)
      }
      const savedSelection = await persistenceApi.write(
        PersistenceKeys.activeProject,
        activeProjectId
      )
      if (!savedSelection.success) return fail('saving the active project', savedSelection.error)
    }
  }

  await beforeDelete?.()
  const removed = await persistenceApi.delete(LEGACY_PROJECTS_KEY)
  if (!removed.success) return fail('deleting the old project record', removed.error)

  void logFrontendError({
    level: 'info',
    source: 'legacy-project-import',
    message: `migrated ${legacy.length} project(s) from the old record (host imported: ${acknowledged.data.imported})`
  })
  return 'imported'
}
