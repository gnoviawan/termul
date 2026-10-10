/**
 * Working-copy identity (shell revamp AD-1): one canonical-path module that
 * answers "which working copy (project folder or listed worktree) does this
 * path belong to?".
 *
 * Pure and dependency-free: types only. Stores, terminal/session state and the
 * switcher pick are passed in as arguments so this stays testable and nothing
 * here logs (consumers log `[working-copy]`).
 *
 * A working copy is identified by its canonical path; branch names are never
 * identity. `key` (= `normalizePath(path)`) is for comparisons and map keys,
 * `path` is the stored, display-case path usable as a cwd.
 */

import type { WorkspaceTab } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

export type WorkingCopy =
  | {
      state: 'resolved'
      kind: 'project' | 'worktree'
      key: string
      path: string
      worktreeId: string | null
    }
  /** A path inside `<project>/.termul/worktrees/` that no listed worktree
   * contains (pruned or not yet reconciled). `key`/`path` name the managed
   * worktree directory. Never falls back to the project folder. */
  | { state: 'unresolved'; key: string; path: string }

export interface TabPathSources {
  /** Cwd of an agent-chat session. */
  sessionCwd: (sessionId: string) => string | null | undefined
  /** Live cwd of a terminal. */
  terminalCwd: (terminalId: string) => string | null | undefined
}

type ProjectPaths = Pick<Project, 'path' | 'worktrees'>

export interface ResolveActiveWorkingCopyInput {
  project: ProjectPaths | null | undefined
  activeTab: WorkspaceTab | null | undefined
  /** Canonical worktree path picked in the switcher; injected by the caller. */
  pickedPath: string | null | undefined
  sources: TabPathSources
}

const MANAGED_SEGMENTS = '.termul/worktrees'
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/
const DRIVE_ROOT = /^[A-Za-z]:\/$/

/** `//?/C:/x` -> `C:/x`, `//?/UNC/srv/share/p` -> `//srv/share/p`; any other
 * path (including an unrecognised `//?/` form) is returned untouched. */
function stripVerbatimPrefix(path: string): string {
  if (!path.startsWith('//?/')) return path
  const rest = path.slice('//?/'.length)
  if (/^UNC\//i.test(rest)) return `//${rest.slice('UNC/'.length)}`
  if (/^[A-Za-z]:$/.test(rest)) return `${rest}/`
  if (/^[A-Za-z]:\//.test(rest)) return rest
  return path
}

/** Collapses duplicate slashes, keeping a leading `//` (UNC) as is. */
function collapseSlashes(path: string): string {
  if (/^\/\/(?!\/)/.test(path)) return `//${path.slice(2).replace(/\/{2,}/g, '/')}`
  return path.replace(/\/{2,}/g, '/')
}

/** Resolves `.` and `..`, keeping a UNC (`//`), posix (`/`) or drive (`C:/`)
 * root; `..` cannot climb above a root. */
function resolveDotSegments(path: string): string {
  if (!DOT_SEGMENT.test(path)) return path
  const root = /^(?:\/\/|[A-Za-z]:\/|\/)/.exec(path)?.[0] ?? ''
  const kept: string[] = []
  for (const segment of path.slice(root.length).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') kept.push(segment)
    else if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
    else if (!root) kept.push('..')
  }
  return root + kept.join('/')
}

function isWindowsForm(path: string): boolean {
  return /^[A-Za-z]:(\/|$)/.test(path) || /^\/\/(?!\/)/.test(path)
}

/** Case-preserving canonical form (no case fold). */
function canonicalize(path: string): string {
  if (!path) return ''
  const slashed = collapseSlashes(stripVerbatimPrefix(path.replace(/\\/g, '/')))
  const resolved = resolveDotSegments(slashed)
  if (resolved === '/' || DRIVE_ROOT.test(resolved)) return resolved
  return resolved.replace(/\/+$/, '') || '/'
}

/**
 * Canonical comparison form of a path: forward slashes, no verbatim prefix, no
 * duplicate or trailing slashes (roots `/` and `C:/` keep theirs), dot segments
 * resolved, lowercased only for Windows-form paths (drive letter or UNC).
 */
export function normalizePath(path: string): string {
  const canonical = canonicalize(path)
  return isWindowsForm(canonical) ? canonical.toLowerCase() : canonical
}

function joinKey(base: string, rest: string): string {
  return base.endsWith('/') ? `${base}${rest}` : `${base}/${rest}`
}

/** Segment-bounded containment of normalized keys (equal counts). */
function containsKey(parentKey: string, key: string): boolean {
  if (key === parentKey) return true
  return key.startsWith(parentKey.endsWith('/') ? parentKey : `${parentKey}/`)
}

interface Candidate {
  key: string
  path: string
  kind: 'project' | 'worktree'
  worktreeId: string | null
}

function usablePath(path: string | null | undefined): path is string {
  return typeof path === 'string' && normalizePath(path) !== ''
}

/** Project folder first, so it wins ties on equal depth. */
function candidatesOf(project: ProjectPaths): Candidate[] {
  const out: Candidate[] = []
  if (usablePath(project.path)) {
    out.push({
      key: normalizePath(project.path),
      path: project.path,
      kind: 'project',
      worktreeId: null
    })
  }
  for (const worktree of project.worktrees ?? []) {
    if (!usablePath(worktree.path)) continue
    out.push({
      key: normalizePath(worktree.path),
      path: worktree.path,
      kind: 'worktree',
      worktreeId: worktree.id
    })
  }
  return out
}

function resolved(candidate: Candidate): WorkingCopy {
  return {
    state: 'resolved',
    kind: candidate.kind,
    key: candidate.key,
    path: candidate.path,
    worktreeId: candidate.worktreeId
  }
}

/** The managed worktree directory (`<project>/.termul/worktrees/<name>`) a
 * path sits strictly under, or `null`. */
function managedWorktreeDir(
  path: string,
  key: string,
  project: ProjectPaths
): { key: string; path: string } | null {
  if (!usablePath(project.path)) return null
  const projectKey = normalizePath(project.path)
  const prefix = joinKey(projectKey, `${MANAGED_SEGMENTS}/`)
  if (!key.startsWith(prefix) || key.length === prefix.length) return null
  const depth = prefix.split('/').length - 1 // segments in `<project>/.termul/worktrees`
  const dirKey = key
    .split('/')
    .slice(0, depth + 1)
    .join('/')
  const dirPath = canonicalize(path)
    .split('/')
    .slice(0, depth + 1)
    .join('/')
  return { key: dirKey, path: dirPath }
}

/**
 * The working copy that contains `path`: the deepest listed one (project folder
 * or any listed worktree) by segment-bounded prefix; the project folder wins
 * ties. A path under `<project>/.termul/worktrees/` that no listed worktree
 * contains is `unresolved`, never the project folder. Anything else is `null`.
 */
export function workingCopyOf(
  path: string | null | undefined,
  project: ProjectPaths | null | undefined
): WorkingCopy | null {
  if (!project || !path) return null
  const key = normalizePath(path)
  if (!key) return null

  let best: Candidate | null = null
  for (const candidate of candidatesOf(project)) {
    if (!containsKey(candidate.key, key)) continue
    if (!best || candidate.key.length > best.key.length) best = candidate
  }
  if (best?.kind === 'worktree') return resolved(best)

  const managed = managedWorktreeDir(path, key, project)
  if (managed) return { state: 'unresolved', key: managed.key, path: managed.path }
  return best ? resolved(best) : null
}

/** The path a tab is "about", or `null` for tabs without one. */
export function tabPath(
  tab: WorkspaceTab | null | undefined,
  sources: TabPathSources
): string | null {
  if (!tab) return null
  let value: string | null | undefined
  switch (tab.type) {
    case 'agent-chat':
      value = sources.sessionCwd(tab.sessionId)
      break
    case 'terminal':
      value = sources.terminalCwd(tab.terminalId)
      break
    case 'editor':
      value = tab.filePath
      break
    default:
      // browser, canvas, git, git-history and any future kind carry no path.
      return null
  }
  return value?.trim() ? value : null
}

/** The listed worktree the pick names, else the project folder, else `null`. */
export function pickedWorkingCopy(
  project: ProjectPaths | null | undefined,
  pickedPath: string | null | undefined
): WorkingCopy | null {
  if (!project) return null
  const candidates = candidatesOf(project)
  if (pickedPath) {
    const key = normalizePath(pickedPath)
    const hit = key ? candidates.find((c) => c.kind === 'worktree' && c.key === key) : undefined
    if (hit) return resolved(hit)
  }
  const projectFolder = candidates.find((c) => c.kind === 'project')
  return projectFolder ? resolved(projectFolder) : null
}

/**
 * The working copy the active tab belongs to; an `unresolved` result is
 * returned as is. Falls back to the switcher pick when the tab has no path or
 * its path is inside no working copy.
 */
export function resolveActiveWorkingCopy(input: ResolveActiveWorkingCopyInput): WorkingCopy | null {
  const { project, activeTab, pickedPath, sources } = input
  const fromTab = workingCopyOf(tabPath(activeTab, sources), project)
  return fromTab ?? pickedWorkingCopy(project, pickedPath)
}
