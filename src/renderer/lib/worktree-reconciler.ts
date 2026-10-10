/**
 * Single-flight worktree reconciler (shell revamp CAP-14, AD-3).
 *
 * The ONLY writer of `project.worktrees`. It lists `git worktree list` through
 * the transport-neutral `worktreeApi` (Tauri IPC on desktop, the web route in
 * the browser) and merges the listing into the project store:
 *
 * - upsert by canonical path key (existing id kept, `branch`/`name` refreshed,
 *   missing entries added with a path-derived id),
 * - prune entries absent from a SUCCESSFUL listing (a failed listing never
 *   touches `worktrees`),
 * - merge against the store state read at commit time (never a snapshot taken
 *   before an `await`) and commit with one `updateProject` call.
 *
 * Calls are single-flight with coalescing: a call made while a run is in flight
 * joins ONE trailing run that starts after the in-flight one settles, so an
 * awaiting caller always observes a listing started after its call (a worktree
 * it just created is visible), while N overlapping callers cost at most two
 * `list` calls.
 */

import { normalizeCwdForScope } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { worktreeApi } from '@/lib/worktree-api'
import { useProjectStore } from '@/stores/project-store'
import type { Project, Worktree } from '@/types/project'

export type ReconcileOutcome = 'updated' | 'unchanged' | 'skipped' | 'failed'

/** Minimal shape of one `git worktree list` entry (see `WorktreeInfo`). */
export interface ListedWorktree {
  name: string
  branch: string
  path: string
}

const LOG_PREFIX = '[worktree-reconcile]'

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/

/**
 * Canonical comparison key for a filesystem path: separator/verbatim-prefix/
 * trailing-slash normalized, and lower-cased for Windows drive/UNC paths
 * (case-insensitive file systems). Kept in ONE place so it can later be swapped
 * for the shared working-copy `normalizePath`.
 */
export function worktreeKey(path: string): string {
  const normalized = normalizeCwdForScope(path)
  const isWindowsPath = WINDOWS_DRIVE_RE.test(normalized) || normalized.startsWith('//')
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

/** cyrb53 string hash: stable, dependency-free, 53 bits. */
function hashString(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * Deterministic worktree id derived from the canonical path key. `attempt` > 0
 * salts the hash so the caller can resolve a collision with a different path.
 */
export function worktreeIdForPath(path: string, attempt = 0): string {
  const key = worktreeKey(path)
  const salted = attempt === 0 ? key : `${key}#${attempt}`
  return `wt-${hashString(salted).toString(16).padStart(14, '0')}`
}

/** Segment-bounded containment test on canonical keys (`root` itself counts as inside). */
export function isPathInsideRoot(path: string, root: string): boolean {
  const key = worktreeKey(path)
  const rootKey = worktreeKey(root)
  return key === rootKey || key.startsWith(`${rootKey}/`)
}

export interface MergeWorktreesInput {
  stored: readonly Worktree[]
  listed: readonly ListedWorktree[]
  projectPath: string
  /** Flag listed paths outside the project folder (web only). */
  flagOutsideRoot: boolean
  now?: string
}

export interface MergeWorktreesResult {
  worktrees: Worktree[]
  added: number
  updated: number
  removed: number
}

function withOutsideFlag(worktree: Worktree, outside: boolean): Worktree {
  if (outside)
    return worktree.outsideProjectRoot ? worktree : { ...worktree, outsideProjectRoot: true }
  if (worktree.outsideProjectRoot === undefined) return worktree
  const { outsideProjectRoot: _drop, ...rest } = worktree
  return rest
}

/**
 * Pure merge of the stored worktrees with a successful listing. Entries that
 * are unchanged keep their object identity so callers can detect "no change"
 * cheaply. The project root is never kept as a worktree.
 */
export function mergeWorktrees(input: MergeWorktreesInput): MergeWorktreesResult {
  const { stored, listed, projectPath, flagOutsideRoot } = input
  const now = input.now ?? new Date().toISOString()
  const rootKey = worktreeKey(projectPath)

  const listedByKey = new Map<string, ListedWorktree>()
  for (const entry of listed) {
    const key = worktreeKey(entry.path)
    if (key === rootKey || listedByKey.has(key)) continue
    listedByKey.set(key, entry)
  }

  const result: Worktree[] = []
  const seen = new Set<string>()
  let updated = 0
  let removed = 0

  for (const worktree of stored) {
    const key = worktreeKey(worktree.path)
    const entry = listedByKey.get(key)
    if (!entry || seen.has(key)) {
      removed++
      continue
    }
    seen.add(key)
    let next = worktree
    if (worktree.branch !== entry.branch || worktree.name !== entry.name) {
      next = { ...worktree, branch: entry.branch, name: entry.name }
    }
    if (flagOutsideRoot) next = withOutsideFlag(next, !isPathInsideRoot(entry.path, projectPath))
    if (next !== worktree) updated++
    result.push(next)
  }

  const usedIds = new Set(result.map((w) => w.id))
  let added = 0
  for (const [key, entry] of listedByKey) {
    if (seen.has(key)) continue
    let attempt = 0
    let id = worktreeIdForPath(entry.path, attempt)
    while (usedIds.has(id)) id = worktreeIdForPath(entry.path, ++attempt)
    usedIds.add(id)
    const created: Worktree = {
      id,
      name: entry.name,
      branch: entry.branch,
      path: entry.path,
      createdAt: now
    }
    result.push(
      flagOutsideRoot
        ? withOutsideFlag(created, !isPathInsideRoot(entry.path, projectPath))
        : created
    )
    added++
  }

  return { worktrees: result, added, updated, removed }
}

function findProject(projectId: string): Project | undefined {
  return useProjectStore.getState().projects.find((p) => p.id === projectId)
}

function sameWorktrees(a: readonly Worktree[], b: readonly Worktree[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i])
}

/** One list + commit cycle. Never rejects. */
async function runOnce(projectId: string): Promise<ReconcileOutcome> {
  try {
    const initial = findProject(projectId)
    if (!initial?.path) {
      console.debug(`${LOG_PREFIX} skipped project=${projectId} (no project or no path)`)
      return 'skipped'
    }
    const projectPath = initial.path

    // `list` may return undefined (facade not ready) or throw synchronously.
    let listing: Awaited<ReturnType<typeof worktreeApi.list>> | undefined
    try {
      listing = await worktreeApi.list(projectPath)
    } catch (err) {
      console.debug(`${LOG_PREFIX} list threw project=${projectId}`, err)
      listing = undefined
    }

    // Everything below reads the CURRENT store state, not `initial`.
    const current = findProject(projectId)
    if (!current?.path || worktreeKey(current.path) !== worktreeKey(projectPath)) {
      console.debug(`${LOG_PREFIX} skipped project=${projectId} (project changed or removed)`)
      return 'skipped'
    }

    if (!listing?.success || !listing.data) {
      const code = listing && !listing.success ? listing.code : undefined
      if ((code === 'NOT_A_GIT_REPO' || code === 'GIT_NOT_FOUND') && current.isGitRepo !== false) {
        useProjectStore.getState().updateProject(projectId, { isGitRepo: false })
      }
      console.debug(`${LOG_PREFIX} listing failed project=${projectId} code=${code ?? 'none'}`)
      return 'failed'
    }

    const storedList = current.worktrees ?? []
    const merged = mergeWorktrees({
      stored: storedList,
      listed: listing.data,
      projectPath: current.path,
      flagOutsideRoot: !isTauriContext()
    })

    const patch: Partial<Project> = {}
    const listChanged = !sameWorktrees(storedList, merged.worktrees)
    if (listChanged && !(current.worktrees === undefined && merged.worktrees.length === 0)) {
      patch.worktrees = merged.worktrees
    }
    const activeId = current.activeWorktreeId
    if (activeId && !merged.worktrees.some((w) => w.id === activeId)) {
      patch.activeWorktreeId = null
    }
    if (current.isGitRepo !== true) patch.isGitRepo = true

    if (Object.keys(patch).length === 0) {
      console.debug(`${LOG_PREFIX} unchanged project=${projectId} count=${merged.worktrees.length}`)
      return 'unchanged'
    }
    useProjectStore.getState().updateProject(projectId, patch)
    console.debug(
      `${LOG_PREFIX} ok project=${projectId} added=${merged.added} updated=${merged.updated} removed=${merged.removed}`
    )
    return 'updated'
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'worktreeReconciler',
      message: `reconcile threw project=${projectId}: ${err instanceof Error ? err.message : String(err)}`
    })
    return 'failed'
  }
}

interface Flight {
  /** Settles (never rejects) when this flight's run finishes. */
  done: Promise<ReconcileOutcome>
  /** False while the flight is queued behind the in-flight run. */
  started: boolean
}

const flights = new Map<string, Flight>()

function launchFlight(
  projectId: string,
  prior: Promise<unknown> | null
): Promise<ReconcileOutcome> {
  const flight: Flight = { started: prior === null, done: undefined as never }
  flight.done = (async () => {
    if (prior) await prior
    flight.started = true
    return runOnce(projectId)
  })()
  flights.set(projectId, flight)
  void flight.done.then(() => {
    if (flights.get(projectId) === flight) flights.delete(projectId)
  })
  return flight.done
}

/**
 * Reconcile `project.worktrees` with `git worktree list`. Single-flight per
 * project: while a run is in flight, callers share ONE trailing run that starts
 * after it settles. Never rejects.
 */
export function reconcileProjectWorktrees(projectId: string): Promise<ReconcileOutcome> {
  const current = flights.get(projectId)
  if (!current) return launchFlight(projectId, null)
  // A queued trailing run has not listed yet: join it.
  if (!current.started) return current.done
  return launchFlight(projectId, current.done)
}
