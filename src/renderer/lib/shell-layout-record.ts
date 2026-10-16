/**
 * Shell-layout record (shell revamp AD-4): the persisted shape, defaults,
 * resize bounds and the load-time sanitizer. Pure and dependency-free so both
 * `stores/shell-layout-store.ts` and `lib/shell-layout-migration.ts` can use
 * it without importing each other.
 */

/**
 * Version 2 replaced `graphHeight` (the docked Graph is gone) with
 * `gitHistoryDetailWidth`. The sanitizer drops unknown fields, so a version 1
 * record loads as is; a build that only knows version 1 reads version 2 as
 * newer and leaves it alone.
 */
export const SHELL_LAYOUT_VERSION = 2

/** Tabs the Side panel remembers per project. SSH is a mode, never a last tab. */
export const SHELL_LAST_COLUMN_TABS = ['chats', 'explorer', 'changes'] as const
export type ShellLastColumnTab = (typeof SHELL_LAST_COLUMN_TABS)[number]

export interface ShellLayoutBounds {
  min: number
  max: number
  default: number
}

export const SHELL_LAYOUT_BOUNDS = {
  railWidth: { min: 180, max: 360, default: 200 },
  sidePanelWidth: { min: 220, max: 560, default: 260 },
  sshSectionHeight: { min: 48, max: 400, default: 140 },
  gitHistoryDetailWidth: { min: 320, max: 560, default: 400 }
} as const satisfies Record<string, ShellLayoutBounds>

export interface ShellLayoutRecord {
  version: number
  railExpanded: boolean
  railWidth: number
  sidePanelVisible: boolean
  sidePanelWidth: number
  sshSectionVisible: boolean
  sshSectionHeight: number
  gitHistoryDetailWidth: number
  lastColumnTabByProject: Record<string, ShellLastColumnTab>
  /** Normalized working-copy path (a key, not a cwd) per project. */
  worktreePickByProject: Record<string, string>
}

export function defaultShellLayoutRecord(): ShellLayoutRecord {
  return {
    version: SHELL_LAYOUT_VERSION,
    railExpanded: true,
    railWidth: SHELL_LAYOUT_BOUNDS.railWidth.default,
    sidePanelVisible: true,
    sidePanelWidth: SHELL_LAYOUT_BOUNDS.sidePanelWidth.default,
    sshSectionVisible: true,
    sshSectionHeight: SHELL_LAYOUT_BOUNDS.sshSectionHeight.default,
    gitHistoryDetailWidth: SHELL_LAYOUT_BOUNDS.gitHistoryDetailWidth.default,
    lastColumnTabByProject: {},
    worktreePickByProject: {}
  }
}

/** Rounds and clamps a finite number to `bounds`; anything else is the default. */
export function clampToBounds(value: unknown, bounds: ShellLayoutBounds): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.default
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

export function isShellLastColumnTab(value: unknown): value is ShellLastColumnTab {
  return typeof value === 'string' && (SHELL_LAST_COLUMN_TABS as readonly string[]).includes(value)
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Keeps entries whose key is a safe non-empty string and whose value passes `accept`. */
function sanitizeMap<T extends string>(
  value: unknown,
  accept: (entry: unknown) => entry is T
): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isRecordObject(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (key === '' || key === '__proto__') continue
    if (accept(entry)) out[key] = entry
  }
  return out
}

/**
 * Builds a valid record from untrusted persisted data: every number is
 * clamped, bad map entries are dropped, unknown fields are ignored, and
 * `version` is always the current one (callers reject newer versions first).
 */
export function sanitizeShellLayout(raw: unknown): ShellLayoutRecord {
  const defaults = defaultShellLayoutRecord()
  if (!isRecordObject(raw)) return defaults
  return {
    version: SHELL_LAYOUT_VERSION,
    railExpanded: booleanOr(raw.railExpanded, defaults.railExpanded),
    railWidth: clampToBounds(raw.railWidth, SHELL_LAYOUT_BOUNDS.railWidth),
    sidePanelVisible: booleanOr(raw.sidePanelVisible, defaults.sidePanelVisible),
    sidePanelWidth: clampToBounds(raw.sidePanelWidth, SHELL_LAYOUT_BOUNDS.sidePanelWidth),
    sshSectionVisible: booleanOr(raw.sshSectionVisible, defaults.sshSectionVisible),
    sshSectionHeight: clampToBounds(raw.sshSectionHeight, SHELL_LAYOUT_BOUNDS.sshSectionHeight),
    gitHistoryDetailWidth: clampToBounds(
      raw.gitHistoryDetailWidth,
      SHELL_LAYOUT_BOUNDS.gitHistoryDetailWidth
    ),
    lastColumnTabByProject: sanitizeMap(raw.lastColumnTabByProject, isShellLastColumnTab),
    worktreePickByProject: sanitizeMap(raw.worktreePickByProject, isNonEmptyString)
  }
}
