/**
 * Rail worktree switcher rows (shell revamp CAP-6): the project folder plus one
 * row per listed worktree, each with the number of open tabs that live there
 * and a "working" flag.
 *
 * Pure: tabs, sessions and terminals are passed in as plain arrays so nothing
 * here reads a store. Attribution goes through `workingCopyOf` (deepest listed
 * path wins, normalized comparison), never raw path equality.
 */

import { normalizePath, type TabPathSources, tabPath, workingCopyOf } from '@/lib/working-copy'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { Project, Terminal } from '@/types/project'

export interface WorkspaceRow {
  /** `normalizePath(path)`: identity for comparisons and React keys. */
  key: string
  kind: 'project' | 'worktree'
  worktreeId: string | null
  /** Stored, display-case path; usable as a cwd and as the pick value. */
  path: string
  label: string
  /** Worktree flagged `outsideProjectRoot`: listed but not usable here. */
  outsideProjectRoot: boolean
  /** Tabs (of every leaf pane) whose path resolves to this row. */
  openTabCount: number
  /** A busy chat or an active terminal runs in this row. */
  running: boolean
}

/** A live ACP session, reduced to what the rows need. */
export interface WorkspaceRowSession {
  id: string
  projectId: string
  cwd: string
  /** `sessionTurnBusy(session)`. */
  busy: boolean
  /** `isEphemeralAcpSession(id)`: warm-pool seeds are not chats. */
  ephemeral: boolean
}

export type WorkspaceRowTerminal = Pick<
  Terminal,
  'id' | 'projectId' | 'cwd' | 'healthStatus' | 'hasActivity'
>

export interface BuildWorkspaceRowsInput {
  project: Pick<Project, 'id' | 'path' | 'worktrees' | 'gitBranch' | 'isGitRepo'>
  /** Tabs of every leaf pane in the active workspace tree. */
  tabs: readonly WorkspaceTab[]
  sessions: readonly WorkspaceRowSession[]
  terminals: readonly WorkspaceRowTerminal[]
}

export const WORKSPACE_ROW_FALLBACK_LABEL = 'Workspace'

/** Label of a worktree row: its branch, else its name. */
export function worktreeLabel(worktree: { branch: string; name: string }): string {
  return worktree.branch || worktree.name
}

/** Label of the project-folder row: the folder's branch, else `Workspace`. */
export function projectFolderLabel(project: Pick<Project, 'gitBranch'>): string {
  return project.gitBranch || WORKSPACE_ROW_FALLBACK_LABEL
}

function countOpenTabs(
  tabs: readonly WorkspaceTab[],
  project: BuildWorkspaceRowsInput['project'],
  sources: TabPathSources
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const tab of tabs) {
    const wc = workingCopyOf(tabPath(tab, sources), project)
    if (wc?.state === 'resolved') counts.set(wc.key, (counts.get(wc.key) ?? 0) + 1)
  }
  return counts
}

function collectRunning(input: BuildWorkspaceRowsInput): Set<string> {
  const { project, sessions, terminals } = input
  const running = new Set<string>()
  const mark = (cwd: string | null | undefined): void => {
    const wc = workingCopyOf(cwd, project)
    if (wc?.state === 'resolved') running.add(wc.key)
  }
  for (const session of sessions) {
    if (session.projectId === project.id && !session.ephemeral && session.busy) mark(session.cwd)
  }
  // The repo has no foreground-process signal: a running terminal with recent
  // output activity is the proxy for "something is working there".
  for (const terminal of terminals) {
    if (
      terminal.projectId === project.id &&
      terminal.healthStatus === 'running' &&
      terminal.hasActivity === true
    ) {
      mark(terminal.cwd)
    }
  }
  return running
}

/**
 * The project folder first, then every listed worktree in listed order. A
 * project without a usable path has no project-folder row; a project that is
 * not a git repo shows the folder row only.
 */
export function buildWorkspaceRows(input: BuildWorkspaceRowsInput): WorkspaceRow[] {
  const { project, tabs, sessions, terminals } = input
  const sessionCwd = new Map(sessions.map((s) => [s.id, s.cwd]))
  const terminalCwd = new Map(terminals.map((t) => [t.id, t.cwd]))
  const sources: TabPathSources = {
    sessionCwd: (id) => sessionCwd.get(id),
    terminalCwd: (id) => terminalCwd.get(id)
  }
  const counts = countOpenTabs(tabs, project, sources)
  const running = collectRunning(input)

  const rows: WorkspaceRow[] = []
  if (project.path && normalizePath(project.path)) {
    const key = normalizePath(project.path)
    rows.push({
      key,
      kind: 'project',
      worktreeId: null,
      path: project.path,
      label: projectFolderLabel(project),
      outsideProjectRoot: false,
      openTabCount: counts.get(key) ?? 0,
      running: running.has(key)
    })
  }
  if (project.isGitRepo !== true) return rows

  for (const worktree of project.worktrees ?? []) {
    const key = normalizePath(worktree.path)
    if (!key) continue
    rows.push({
      key,
      kind: 'worktree',
      worktreeId: worktree.id,
      path: worktree.path,
      label: worktreeLabel(worktree),
      outsideProjectRoot: worktree.outsideProjectRoot === true,
      openTabCount: counts.get(key) ?? 0,
      running: running.has(key)
    })
  }
  return rows
}

/** Case-insensitive substring filter on the label; a blank query keeps all. */
export function filterWorkspaceRows(
  rows: readonly WorkspaceRow[],
  query: string
): readonly WorkspaceRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((row) => row.label.toLowerCase().includes(needle))
}

/**
 * The worktree name a query would create, sanitized like `NewWorktreeModal`
 * (anything outside `[a-zA-Z0-9/_.-]` becomes `-`, runs collapse, edges trim);
 * the empty string when nothing usable is left.
 */
export function worktreeNameFromQuery(query: string): string {
  return query
    .trim()
    .replace(/[^a-zA-Z0-9/_.-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '')
}
