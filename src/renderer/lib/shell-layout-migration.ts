/**
 * One-time carry-over of legacy shell layout state into the shell-layout
 * record (shell revamp AD-4, CAP-16).
 *
 * The builder is pure. `readLegacyShellLayoutSources` reads RAW persisted
 * values (never the in-memory settings store, whose defaults would pose as
 * saved choices). Legacy fields and keys are left in place; the record's
 * existence is what stops a second migration.
 */

import { PersistenceKeys } from '@shared/types/persistence.types'
import { persistenceApi } from '@/lib/api'
import { LEGACY_PROJECTS_KEY } from '@/lib/legacy-project-import'
import {
  clampToBounds,
  defaultShellLayoutRecord,
  SHELL_LAYOUT_BOUNDS,
  type ShellLayoutRecord
} from '@/lib/shell-layout-record'
import { isTauriContext } from '@/lib/tauri-runtime'
import { normalizePath } from '@/lib/working-copy'

export const LEGACY_EXPLORER_WIDTH_KEY = 'termul:file-explorer-width'
export const LEGACY_SSH_HEIGHT_KEY = 'termul-ssh-panel-height'

/** Raw legacy values; each is `null`/`undefined` when it was absent. */
export interface LegacyShellLayoutSources {
  /** Raw persisted `settings/app` data. */
  appSettings: unknown
  /** Raw `localStorage` string for the explorer width. */
  explorerWidth: string | null
  /** Raw `localStorage` string for the SSH panel height. */
  sshHeight: string | null
  /** Raw persisted `projects` data; desktop only. */
  projects: unknown
}

export interface LegacyShellLayoutSourceCounts {
  flags: number
  widths: number
  picks: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Upgrades a raw persisted record older than version 3 before it is
 * sanitized: a remembered `chats` view (retired in Sidebar V2 P3) becomes
 * `explorer`, so the project keeps an entry instead of losing it to the
 * sanitizer. Visibility and width carry over unchanged. Newer or
 * non-object data is returned as is.
 */
export function upgradeShellLayoutRecord(raw: unknown): unknown {
  if (!isObject(raw) || Array.isArray(raw)) return raw
  const version = typeof raw.version === 'number' ? raw.version : 0
  if (version >= 3) return raw
  const tabs = raw.lastColumnTabByProject
  if (!isObject(tabs) || Array.isArray(tabs)) return raw
  const upgraded = Object.fromEntries(
    Object.entries(tabs).map(([projectId, tab]) => [projectId, tab === 'chats' ? 'explorer' : tab])
  )
  return { ...raw, lastColumnTabByProject: upgraded }
}

function parseLegacyInt(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/** `{ projectId -> normalized path }` from each project's persisted `activeWorktreeId`. */
function legacyWorktreePicks(projects: unknown): Record<string, string> {
  const picks: Record<string, string> = {}
  if (!isObject(projects) || !Array.isArray(projects.projects)) return picks
  for (const project of projects.projects as unknown[]) {
    if (!isObject(project)) continue
    const { id, activeWorktreeId, worktrees } = project
    if (typeof id !== 'string' || id === '' || id === '__proto__') continue
    if (typeof activeWorktreeId !== 'string' || !Array.isArray(worktrees)) continue
    const worktree = (worktrees as unknown[]).find(
      (candidate) => isObject(candidate) && candidate.id === activeWorktreeId
    )
    if (!isObject(worktree) || typeof worktree.path !== 'string' || worktree.path === '') continue
    const key = normalizePath(worktree.path)
    if (key !== '') picks[id] = key
  }
  return picks
}

export function buildMigratedShellLayout(legacy: LegacyShellLayoutSources): ShellLayoutRecord {
  const record = defaultShellLayoutRecord()
  const settings = isObject(legacy.appSettings) ? legacy.appSettings : {}

  if (typeof settings.sidebarVisible === 'boolean') record.railExpanded = settings.sidebarVisible
  if (typeof settings.fileExplorerVisible === 'boolean') {
    record.sidePanelVisible = settings.fileExplorerVisible
  }
  if (typeof settings.sshPanelVisible === 'boolean') {
    record.sshSectionVisible = settings.sshPanelVisible
  }

  record.sidePanelWidth = clampToBounds(
    parseLegacyInt(legacy.explorerWidth),
    SHELL_LAYOUT_BOUNDS.sidePanelWidth
  )
  record.sshSectionHeight = clampToBounds(
    parseLegacyInt(legacy.sshHeight),
    SHELL_LAYOUT_BOUNDS.sshSectionHeight
  )
  record.worktreePickByProject = legacyWorktreePicks(legacy.projects)
  return record
}

/** How many legacy values fed the record, for the one-line migration log. */
export function countLegacyShellLayoutSources(
  legacy: LegacyShellLayoutSources
): LegacyShellLayoutSourceCounts {
  const settings = isObject(legacy.appSettings) ? legacy.appSettings : {}
  const flags = ['sidebarVisible', 'fileExplorerVisible', 'sshPanelVisible'].filter(
    (field) => typeof settings[field] === 'boolean'
  ).length
  const widths = [legacy.explorerWidth, legacy.sshHeight].filter(
    (raw) => parseLegacyInt(raw) !== null
  ).length
  return { flags, widths, picks: Object.keys(legacyWorktreePicks(legacy.projects)).length }
}

function readLocalStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

async function readRaw(key: string): Promise<unknown> {
  try {
    const result = await persistenceApi.read<unknown>(key)
    return result.success ? (result.data ?? null) : null
  } catch {
    return null
  }
}

/**
 * Reads the raw legacy values. Absent or unreadable sources become `null`
 * (-> defaults); the worktree picks are desktop only, where `activeWorktreeId`
 * lives in the persisted `projects` record.
 */
export async function readLegacyShellLayoutSources(): Promise<LegacyShellLayoutSources> {
  const [appSettings, projects] = await Promise.all([
    readRaw(PersistenceKeys.appSettings),
    isTauriContext() ? readRaw(LEGACY_PROJECTS_KEY) : Promise.resolve(null)
  ])
  return {
    appSettings,
    explorerWidth: readLocalStorage(LEGACY_EXPLORER_WIDTH_KEY),
    sshHeight: readLocalStorage(LEGACY_SSH_HEIGHT_KEY),
    projects
  }
}
