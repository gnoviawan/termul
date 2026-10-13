/**
 * Renderer-owned project preferences: everything about a project the host
 * registry does not carry — icon, git state, worktrees, default shell, env
 * vars, symlink dirs — plus the sidebar layout (groups, order). One
 * `project-prefs` record per device, keyed by project id
 * (`PersistenceKeys.projectPrefs`), written through `persistenceApi`.
 *
 * The project list itself comes from the host through the `projects` watch.
 * Secret env var values never reach the record or the host: they live in
 * secure storage under `project:<id>:env:<key>` and the record keeps the
 * `[REDACTED]` placeholder. Only the desktop has secure storage, so only the
 * desktop persists env vars at all.
 *
 * Prefs of a project the watch does not currently list are kept: a list that
 * momentarily lacks a project (the host was reset) must not wipe what the user
 * set up. They go only when this device deletes the project
 * ({@link forgetProjectPrefs}).
 */

import {
  type PersistedEnvVariable,
  type PersistedProjectGroup,
  type PersistedProjectPrefs,
  type PersistedWorktree,
  PersistenceKeys,
  type ProjectPrefsRecord
} from '@shared/types/persistence.types'
import { persistenceApi, secureStorageApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { EnvVariable, Project, ProjectColor, ProjectGroup, Worktree } from '@/types/project'

const REDACTED_VALUE = '[REDACTED]'

/** The fields of a {@link Project} the host registry does not carry. */
export type ClientProjectFields = Pick<
  Project,
  'gitBranch' | 'defaultShell' | 'envVars' | 'worktrees' | 'symlinkDirs' | 'isGitRepo' | 'icon'
>

/** What {@link loadProjectPrefs} read: the sidebar layout. */
export interface ProjectLayout {
  groups: ProjectGroup[]
  /** Project ids in the order the sidebar lists them. */
  order: string[]
}

/** Prefs of every project this device knows, env secrets resolved. */
const known = new Map<string, ClientProjectFields>()
let layout: ProjectLayout = { groups: [], order: [] }
/** In-memory signature (secret values included) of what was last persisted. */
let lastSignature = ''

function secretKey(projectId: string, envKey: string): string {
  return `project:${projectId}:env:${envKey}`
}

async function deleteSecret(projectId: string, envKey: string): Promise<void> {
  const result = await secureStorageApi.deleteSecret(secretKey(projectId, envKey))
  if (!result.success) {
    void logFrontendError({
      level: 'warn',
      source: 'project-prefs.deleteSecret',
      message: `failed to delete secret ${envKey} for project ${projectId}: ${result.error ?? 'unknown'}`
    })
  }
}

/** Store the plain secret values in secure storage; return the env vars with them redacted. */
async function storeSecretsAndRedact(
  projectId: string,
  envVars: EnvVariable[] | undefined
): Promise<EnvVariable[] | undefined> {
  if (!envVars || envVars.length === 0) return envVars
  const result: EnvVariable[] = []
  for (const envVar of envVars) {
    if (!envVar.isSecret) {
      result.push(envVar)
      continue
    }
    if (envVar.value !== REDACTED_VALUE) {
      const stored = await secureStorageApi.setSecret(
        secretKey(projectId, envVar.key),
        envVar.value
      )
      if (!stored.success) {
        // Abort the save rather than write the raw secret (or a placeholder
        // with nothing behind it) to disk.
        throw new Error(
          `Failed to store secret ${envVar.key} for project ${projectId}: ${stored.error ?? 'unknown error'}`
        )
      }
    }
    result.push({ ...envVar, value: REDACTED_VALUE, isSecret: true })
  }
  return result
}

/** Replace placeholders with the secrets held in secure storage. */
async function loadSecrets(
  projectId: string,
  envVars: EnvVariable[] | undefined
): Promise<EnvVariable[] | undefined> {
  if (!envVars || envVars.length === 0) return envVars
  const result: EnvVariable[] = []
  for (const envVar of envVars) {
    if (!(envVar.isSecret && envVar.value === REDACTED_VALUE)) {
      result.push(envVar)
      continue
    }
    const secret = await secureStorageApi.getSecret(secretKey(projectId, envVar.key))
    if (secret.success) {
      result.push({ key: envVar.key, value: secret.data, isSecret: true })
    } else {
      void logFrontendError({
        level: 'warn',
        source: 'project-prefs.loadSecrets',
        message: `failed to load secret ${envVar.key} for project ${projectId}: ${secret.error ?? 'unknown'}`
      })
      result.push(envVar)
    }
  }
  return result
}

/** Delete the secure-storage entries of secrets that `next` no longer has. */
async function cleanupObsoleteSecrets(
  projectId: string,
  previous: EnvVariable[] | undefined,
  next: EnvVariable[] | undefined
): Promise<void> {
  const nextSecretKeys = new Set(next?.filter((v) => v.isSecret).map((v) => v.key))
  for (const envVar of previous ?? []) {
    if (envVar.isSecret && !nextSecretKeys.has(envVar.key)) {
      await deleteSecret(projectId, envVar.key)
    }
  }
}

function toPersistedWorktree(worktree: Worktree): PersistedWorktree {
  return {
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    createdAt: worktree.createdAt
  }
}

/** The client-only fields of a project (the part the prefs record keeps). */
export function clientFieldsOf(project: Project): ClientProjectFields {
  return {
    gitBranch: project.gitBranch,
    defaultShell: project.defaultShell,
    envVars: project.envVars,
    worktrees: project.worktrees,
    symlinkDirs: project.symlinkDirs,
    isGitRepo: project.isGitRepo,
    icon: project.icon
  }
}

function toPersistedPrefs(
  fields: ClientProjectFields,
  envVars: EnvVariable[] | undefined
): PersistedProjectPrefs {
  const prefs: PersistedProjectPrefs = {}
  if (fields.gitBranch !== undefined) prefs.gitBranch = fields.gitBranch
  if (fields.defaultShell !== undefined) prefs.defaultShell = fields.defaultShell
  if (envVars && envVars.length > 0) prefs.envVars = envVars as PersistedEnvVariable[]
  if (fields.worktrees) prefs.worktrees = fields.worktrees.map(toPersistedWorktree)
  if (fields.symlinkDirs) prefs.symlinkDirs = fields.symlinkDirs
  if (fields.isGitRepo !== undefined) prefs.isGitRepo = fields.isGitRepo
  if (fields.icon) prefs.icon = fields.icon
  return prefs
}

async function fromPersistedPrefs(
  projectId: string,
  prefs: PersistedProjectPrefs
): Promise<ClientProjectFields> {
  const fields: ClientProjectFields = {}
  if (prefs.gitBranch !== undefined) fields.gitBranch = prefs.gitBranch
  if (prefs.defaultShell !== undefined) fields.defaultShell = prefs.defaultShell
  if (isTauriContext() && prefs.envVars) {
    fields.envVars = await loadSecrets(projectId, prefs.envVars)
  }
  if (prefs.worktrees) fields.worktrees = prefs.worktrees
  if (prefs.symlinkDirs) fields.symlinkDirs = prefs.symlinkDirs
  if (prefs.isGitRepo !== undefined) fields.isGitRepo = prefs.isGitRepo
  if (prefs.icon) fields.icon = prefs.icon
  return fields
}

/**
 * Read the persisted record into memory (once per renderer start, before the
 * first watch state is applied). A missing record is an empty one. Returns
 * `false` when the record exists but could not be read: the list still comes
 * from the host, but the caller must not save over a record it never saw.
 */
export async function loadProjectPrefs(): Promise<boolean> {
  known.clear()
  layout = { groups: [], order: [] }
  lastSignature = ''
  const result = await persistenceApi.read<ProjectPrefsRecord>(PersistenceKeys.projectPrefs)
  if (!result.success) return result.code === 'KEY_NOT_FOUND'
  if (!result.data) return true
  const record = result.data
  for (const [projectId, prefs] of Object.entries(record.projects ?? {})) {
    known.set(projectId, await fromPersistedPrefs(projectId, prefs))
  }
  layout = {
    groups: (record.groups ?? []).map((group) => ({
      ...group,
      color: group.color as ProjectColor | undefined
    })),
    order: record.order ?? []
  }
  return true
}

/** The remembered client-only fields of a project, if any. */
export function getProjectPrefs(projectId: string): ClientProjectFields | undefined {
  return known.get(projectId)
}

/** The remembered sidebar layout. */
export function getProjectLayout(): ProjectLayout {
  return layout
}

/**
 * Remember the prefs of a project that is not in the store yet (a project this
 * device just registered with a shell or env vars), so the watch state that
 * lists it picks them up. Call {@link persistProjectPrefs} afterwards.
 */
export function rememberProjectPrefs(projectId: string, fields: ClientProjectFields): void {
  known.set(projectId, fields)
}

function signatureOf(projects: Project[], groups: ProjectGroup[], order: string[]): string {
  return JSON.stringify({
    known: [...known.entries()],
    groups,
    order,
    listed: projects.map((p) => p.id)
  })
}

/**
 * Write the prefs record for the current store state. Skips the write when
 * nothing a pref covers changed since the last one (the store replaces its
 * project objects on every watch frame). Secret values go to secure storage;
 * a failed secure-storage write aborts the whole save and throws.
 */
export async function persistProjectPrefs(
  projects: Project[],
  groups: ProjectGroup[],
  previousProjects: Project[]
): Promise<void> {
  const previousById = new Map(previousProjects.map((p) => [p.id, p]))
  for (const project of projects) {
    known.set(project.id, clientFieldsOf(project))
  }
  const listed = new Set(projects.map((p) => p.id))
  const order = [...projects.map((p) => p.id), ...layout.order.filter((id) => !listed.has(id))]
  const signature = signatureOf(projects, groups, order)
  if (signature === lastSignature) return
  // Claimed up front so a burst of store changes saves once; a failure
  // releases it so the same state is tried again.
  lastSignature = signature
  try {
    const persistEnv = isTauriContext()
    const persisted: Record<string, PersistedProjectPrefs> = {}
    for (const [projectId, fields] of known) {
      let envVars: EnvVariable[] | undefined
      if (persistEnv) {
        if (listed.has(projectId)) {
          await cleanupObsoleteSecrets(
            projectId,
            previousById.get(projectId)?.envVars,
            fields.envVars
          )
        }
        // Unlisted projects go through secure storage too: their secrets are
        // either read back from it (same value, rewritten) or entered for a
        // project the watch has not listed yet, and must not be reduced to a
        // placeholder that has nothing behind it.
        envVars = await storeSecretsAndRedact(projectId, fields.envVars)
      }
      persisted[projectId] = toPersistedPrefs(fields, envVars)
    }
    layout = { groups, order }
    const record: ProjectPrefsRecord = {
      projects: persisted,
      groups: groups as PersistedProjectGroup[],
      order,
      updatedAt: new Date().toISOString()
    }
    const written = await persistenceApi.writeDebounced(PersistenceKeys.projectPrefs, record)
    if (!written.success) {
      throw new Error(`project prefs write failed: ${written.error ?? 'unknown error'}`)
    }
  } catch (error) {
    lastSignature = ''
    throw error
  }
}

/**
 * Drop everything remembered for a project this device deleted: its prefs and
 * its secrets in secure storage (`keepSecrets` for prefs that were remembered
 * but never saved, like a registration the host refused). The next
 * {@link persistProjectPrefs} writes the smaller record.
 */
export async function forgetProjectPrefs(
  projectId: string,
  options?: { keepSecrets?: boolean }
): Promise<void> {
  const fields = known.get(projectId)
  known.delete(projectId)
  layout = {
    groups: layout.groups.map((group) => ({
      ...group,
      projectIds: group.projectIds.filter((id) => id !== projectId)
    })),
    order: layout.order.filter((id) => id !== projectId)
  }
  lastSignature = ''
  if (isTauriContext() && !options?.keepSecrets) {
    for (const envVar of fields?.envVars ?? []) {
      if (envVar.isSecret) await deleteSecret(projectId, envVar.key)
    }
  }
}

/** @internal test helper: forget everything held in memory. */
export function _resetProjectPrefsForTests(): void {
  known.clear()
  layout = { groups: [], order: [] }
  lastSignature = ''
}
