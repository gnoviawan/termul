import type { ProjectIcon, TerminalModes } from './ipc.types'

// Persisted terminal data (subset of Terminal for storage)
export interface PersistedTerminal {
  id: string
  name: string
  shell: string
  cwd?: string
  scrollback?: string[] // Legacy text snapshot for restoration fallback
  transcript?: string // Raw PTY transcript for ANSI/styling-preserving restoration; cap at renderer MAX_TRANSCRIPT_CHARS to avoid unbounded persistence
  /**
   * Captured DEC private-mode snapshot (R3). Replayed before `scrollback` on
   * restore via `buildRehydrateSequences` so an alt-screen TUI (vim/tmux/less)
   * screen/modes survive refresh. Optional — absence degrades to content-only.
   */
  modes?: TerminalModes
  // ADR-004.4: terminal-native agent metadata. Persisted so a restored agent
  // terminal re-spawns the agent TUI — but the seed prompt is intentionally NOT
  // persisted, so restore boots the agent fresh rather than re-submitting a
  // stale task. Restore-prompt suppression is enforced in use-terminal-restore.
  kind?: 'shell' | 'agent'
  agentId?: string
  agentName?: string
  agentProgram?: string
  agentArgs?: string[]
}

// Default scrollback limit to prevent excessive storage
export const DEFAULT_SCROLLBACK_LIMIT = 10000

// Stored at terminals/{projectId}.json
export interface PersistedTerminalLayout {
  activeTerminalId: string | null
  terminals: PersistedTerminal[]
  updatedAt: string // ISO timestamp
}

// Window position and size state
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

// Persisted snapshot data (subset of Snapshot for storage)
export interface PersistedSnapshot {
  id: string
  projectId: string
  name: string
  description?: string
  createdAt: string // ISO timestamp
  terminals: PersistedTerminal[]
  activeTerminalId: string | null
  tag?: 'stable' | 'base'
}

// Stored at snapshots/{projectId}.json
export interface PersistedSnapshotList {
  snapshots: PersistedSnapshot[]
  updatedAt: string // ISO timestamp
}

/**
 * Every logical persistence key the renderer reads or writes, declared once.
 * Scope is decided by `KEY_SCOPES` below: a key listed there is shared between
 * devices, every other key is device-scoped. A test keeps both tables in step.
 */
export const PersistenceKeys = {
  terminals: (projectId: string): string => `terminals/${projectId}`,
  snapshots: (projectId: string): string => `snapshots/${projectId}`,
  windowState: 'window-state',
  // App-wide settings records (shared between devices, merged per field).
  appSettings: 'settings/app',
  keyboardShortcuts: 'settings/keyboard-shortcuts',
  contextBarSettings: 'settings/context-bar',
  tocSettings: 'settings/toc',
  pinnedCommands: 'settings/pinned-commands',
  // The palette's recently used command ids (device scope).
  recentCommands: 'settings/recent-commands',
  // Per-project command history of the terminals (device scope).
  commandHistory: (projectId: string): string => `projects/${projectId}/command-history`,
  // The launcher's unsent prompt per project (device scope).
  lastLaunchDraft: (projectId: string): string => `last-launch-draft/${projectId}`,
  // The composer's unsent message per chat session (device scope).
  chatDraft: (projectId: string, sessionId: string): string =>
    `chat-draft/${projectId}/${sessionId}`,
  // ACP agent configuration (shared between devices, merged per field).
  acpAgents: 'acp/agents',
  acpAuthMethods: 'acp/auth-methods',
  acpMcpServers: 'acp/mcp-servers',
  // Recently @-mentioned files. The bare key is the legacy single-map layout
  // (read once for back-compat); each (project, cwd) partition lives under its
  // own key: the caller passes the URI-encoded composite id.
  acpMentionRecentsLegacy: 'acp/mention-recents',
  acpMentionRecents: (partitionId: string): string => `acp/mention-recents/${partitionId}`,
  // SSH profile metadata of the web client (shared, whole-value compare-and-set).
  sshProfiles: 'ssh/profiles',
  // The last crash-recovery session snapshot (device scope).
  sessionsAutoSave: 'sessions/auto-save',
  // Marker: the pre-fold-in `termul-sessions.json` entry was moved to
  // `sessionsAutoSave`; the legacy file is never read again once it is set.
  sessionsLegacyMigrated: 'sessions/legacy-migrated',
  // ADR-004.3 / ADR-004.6: user-defined terminal-native agent definitions.
  customAgents: 'agents/custom',
  // Last-selected agent in the launcher (persisted across sessions).
  // GH-289: value shape is `LastSelectedAgent` ({ agentId, mode }); legacy
  // records carrying only `{ agentId }` are read as `mode: 'cli'`.
  lastSelectedAgent: 'agents/last-selected',
  // Last composer selections (model, thinking level, config, mode, worktree
  // isolation + base branch) per agent-config-id. Restored on launcher mount
  // so the next chat starts with the user's last pick regardless of which
  // surface (launcher or running chatbox) set it.
  lastComposerOptions: (configId: string): string => `agents/composer-options/${configId}`,
  // Last-known model list per agent-config-id (`PersistedModelCatalog`). The
  // composer selector shows another agent's models from it before that agent
  // runs in this app session.
  agentModelCatalog: (configId: string): string => `agents/model-catalog/${configId}`,
  // Config-option values the agent itself REJECTED on set (e.g. a tool
  // advertised as a segment, #1480), per agent-config-id. Value shape is
  // `PersistedRejectedOptionValues` keyed by option id. The composer hides
  // these on panel open so users see only values the agent accepts; entries
  // for options the agent no longer advertises are dropped on load.
  agentRejectedOptionValues: (configId: string): string =>
    `agents/rejected-option-values/${configId}`,
  // Mobile file explorer: last folder the user navigated into, per project.
  // Restored on drawer reopen across close/reopen and page reloads (web only).
  mobileFileExplorerFolder: (projectId: string): string => `mobile-file-explorer/${projectId}`,
  // The device's own active project (device scope: each device keeps its own
  // selection). Written only by an explicit project switch; a device without
  // one lands on the host default project.
  activeProject: 'active-project',
  // Renderer-owned per-project settings and list layout (device scope): the
  // `ProjectPrefsRecord` keyed by project id. The project list itself lives in
  // the host registry; this holds only what the host never sees.
  projectPrefs: 'project-prefs',
  // Per-project workspace record (device scope).
  workspace: (projectId: string): string => `workspace/${projectId}`,
  // Shell-revamp layout record (versioned): rail/side-panel/SSH/graph sizes and
  // visibility plus per-project last column tab and worktree pick. Owned by
  // `stores/shell-layout-store.ts`; written on both desktop and web.
  shellLayout: 'shell-layout'
} as const

/**
 * Scope table for logical persistence keys (spec 9). The ONE declaration of
 * which keys are shared between devices; every other logical key is
 * device-scoped. The Rust legacy-migration table is pinned equal to this block
 * by a parity test that parses it textually: keep one single-quoted literal per
 * line and no quote characters inside comments here.
 *
 * - `sharedLww`: stored under `shared/lww/<key>`, merged per field by the host.
 * - `sharedCas`: stored under `shared/cas/<key>`, whole-value compare-and-set.
 */
// biome-ignore format: one literal per line, parsed textually by the Rust parity test
export const KEY_SCOPES = {
  sharedLww: [
    'settings/app',
    'settings/keyboard-shortcuts',
    'settings/context-bar',
    'settings/toc',
    'settings/pinned-commands',
    'agents/custom',
    'acp/agents',
    'acp/auth-methods',
    'acp/mcp-servers'
  ],
  sharedCas: [
    'ssh/profiles'
  ]
} as const

export type KeyScope = 'device' | 'sharedLww' | 'sharedCas'

export function scopeOf(logicalKey: string): KeyScope {
  if ((KEY_SCOPES.sharedLww as readonly string[]).includes(logicalKey)) return 'sharedLww'
  if ((KEY_SCOPES.sharedCas as readonly string[]).includes(logicalKey)) return 'sharedCas'
  return 'device'
}

/** The host-store key for a logical key: `device/<deviceId>/<k>`, `shared/lww/<k>` or `shared/cas/<k>`. */
export function scopedKey(logicalKey: string, deviceId: string): string {
  switch (scopeOf(logicalKey)) {
    case 'sharedLww':
      return `shared/lww/${logicalKey}`
    case 'sharedCas':
      return `shared/cas/${logicalKey}`
    case 'device':
      return `device/${deviceId}/${logicalKey}`
  }
}

// GH-289: persisted launcher selection — the chosen agent plus its call mode.
// Legacy persisted values may be `{ agentId }` only (migrated to mode 'cli').
export interface LastSelectedAgent {
  agentId: string
  mode: 'cli' | 'acp'
}

// Persisted composer selections per agent-config-id. Written by both the
// launcher (pre-launch pending options + worktree isolation) and the store
// setters (running-chatbox model/mode/config changes). Restored on launcher
// mount. All fields optional — an absent field means "use agent default".
/** Option values the agent rejected, per option id (#1480/#1489). */
export interface PersistedRejectedOptionValues {
  [optionId: string]: string[]
}

export interface PersistedComposerOptions {
  modelId?: string
  modeId?: string
  configValues?: Record<string, string>
  isolationMode?: 'current' | 'worktree'
  baseBranch?: string | null
}

// Last-known model list for one agent config. `modelOption` is the agent's
// `category: 'model'` config option when it has one; `models` is the native
// ACP model state. Either may be null. Lists only: no current pick.
export interface PersistedModelCatalog {
  models: {
    currentModelId: string
    availableModels: { modelId: string; name: string; description?: string | null }[]
  } | null
  modelOption: {
    id: string
    name: string
    currentValue: string
    options: { value: string; name: string; description?: string | null }[]
  } | null
  updatedAt: number
}

/**
 * The renderer-owned `project-prefs` record (`PersistenceKeys.projectPrefs`):
 * everything about a project the host registry does not carry, keyed by
 * project id, plus the sidebar layout (groups, order). Secret env var values
 * are never in it: they sit in secure storage and the record holds the
 * `[REDACTED]` placeholder.
 */
export interface ProjectPrefsRecord {
  projects: Record<string, PersistedProjectPrefs>
  groups: PersistedProjectGroup[]
  /** Project ids in the order the sidebar lists them. */
  order: string[]
  updatedAt: string // ISO timestamp
}

/** One project's client-only settings inside the {@link ProjectPrefsRecord}. */
export interface PersistedProjectPrefs {
  gitBranch?: string
  defaultShell?: string
  envVars?: PersistedEnvVariable[]
  worktrees?: PersistedWorktree[]
  symlinkDirs?: string[]
  /** Git detection (cached). */
  isGitRepo?: boolean
  /**
   * Resolved project icon (spec-project-icon) incl. the renderer-stamped
   * `fetchedAt`. Persisted so a previously resolved icon renders on app start
   * before `use-project-icon` re-resolution completes.
   */
  icon?: ProjectIcon
}

export interface PersistedProjectGroup {
  id: string
  name: string
  projectIds: string[]
  isCollapsed?: boolean
  color?: string
}

export interface PersistedEnvVariable {
  key: string
  value: string
  isSecret?: boolean
}

// ============================================================================
// Worktree Persistence Types
// ============================================================================

/**
 * Persisted worktree data (subset of Worktree for storage)
 * Stored inside the project's {@link PersistedProjectPrefs}.
 */
export interface PersistedWorktree {
  id: string
  name: string
  branch: string
  path: string
  createdAt: string // ISO timestamp
}
