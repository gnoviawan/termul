import type { GitStatusDetail } from '@shared/types/ipc.types'
import { createContext, useContext, useEffect, useMemo } from 'react'
import type { GitDisplayStatus } from '@/lib/git-status-display'
import { logFrontendError } from '@/lib/log-api'
import { useGitStatusStore } from '@/stores/git-status-store'
import { joinTreePath, normalizeTreePath, parentTreePath } from './tree-paths'

/**
 * Git decorations for the file tree (letter + colour per changed file, a dot
 * on folders that hold changes).
 *
 * `git status --porcelain` paths are relative to the repository root. The
 * explorer asks for the status of its own root, so the paths are joined onto
 * that root. Lookups are built once per status update, not once per row.
 */

export interface ExplorerGitDecorations {
  /** Status of a file row, or undefined when the file is clean. */
  getFileStatus: (path: string) => GitDisplayStatus | undefined
  /** True when a folder holds at least one changed path. */
  isDirDirty: (path: string) => boolean
}

const EMPTY_DECORATIONS: ExplorerGitDecorations = {
  getFileStatus: () => undefined,
  isDirDirty: () => false
}

/** When one path has a staged and an unstaged row, the higher rank wins. */
const STATUS_RANK: Record<GitDisplayStatus, number> = {
  deleted: 4,
  added: 3,
  untracked: 2,
  renamed: 1,
  modified: 0
}

/** Strip porcelain quoting (`"a b.txt"`) from a path. */
function unquote(path: string): string {
  return path.length >= 2 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

/**
 * Pure builder (exported for tests): turns the repo-relative status rows into
 * absolute-path lookups for the tree rooted at `rootPath`.
 */
export function buildGitDecorations(
  rootPath: string,
  statuses: GitStatusDetail[] | undefined
): ExplorerGitDecorations {
  if (!statuses || statuses.length === 0) return EMPTY_DECORATIONS

  const root = normalizeTreePath(rootPath)
  const files = new Map<string, GitDisplayStatus>()
  const dirtyDirs = new Set<string>()
  // `git status` collapses an untracked folder to `dir/`. Everything below it
  // is untracked too.
  const untrackedDirs = new Set<string>()

  for (const detail of statuses) {
    const rawRelative = unquote(detail.path)
    const isUntrackedDir = detail.status === 'untracked' && rawRelative.endsWith('/')
    const relative = normalizeTreePath(rawRelative)
    if (!relative) continue
    const absolute = joinTreePath(root, relative)
    const status: GitDisplayStatus = detail.status === 'staged' ? 'modified' : detail.status

    if (isUntrackedDir) {
      untrackedDirs.add(absolute)
      dirtyDirs.add(absolute)
    } else {
      const current = files.get(absolute)
      if (!current || STATUS_RANK[status] > STATUS_RANK[current]) {
        files.set(absolute, status)
      }
    }

    let parent = parentTreePath(absolute)
    while (parent && parent !== root && parent.startsWith(root) && !dirtyDirs.has(parent)) {
      dirtyDirs.add(parent)
      parent = parentTreePath(parent)
    }
  }

  const hasUntrackedAncestor = (path: string): boolean => {
    if (untrackedDirs.size === 0) return false
    let parent = parentTreePath(path)
    while (parent.startsWith(root) && parent !== root) {
      if (untrackedDirs.has(parent)) return true
      parent = parentTreePath(parent)
    }
    return false
  }

  return {
    getFileStatus: (path) => {
      const normalized = normalizeTreePath(path)
      return files.get(normalized) ?? (hasUntrackedAncestor(normalized) ? 'untracked' : undefined)
    },
    isDirDirty: (path) => {
      const normalized = normalizeTreePath(path)
      return dirtyDirs.has(normalized) || hasUntrackedAncestor(normalized)
    }
  }
}

const ExplorerGitDecorationsContext = createContext<ExplorerGitDecorations>(EMPTY_DECORATIONS)

export const ExplorerGitDecorationsProvider = ExplorerGitDecorationsContext.Provider

export function useExplorerGitDecorationsContext(): ExplorerGitDecorations {
  return useContext(ExplorerGitDecorationsContext)
}

/**
 * Reads the git status of `rootPath` and builds the row lookups. Asks for one
 * status refresh when the explorer mounts or the project changes. No polling:
 * the Git panel and mutations keep the store current after that.
 */
export function useExplorerGitDecorations(rootPath: string | null): ExplorerGitDecorations {
  const statuses = useGitStatusStore((state) => (rootPath ? state.statuses[rootPath] : undefined))

  useEffect(() => {
    if (!rootPath) return
    useGitStatusStore
      .getState()
      .refreshStatus(rootPath)
      .catch((error: unknown) => {
        // Not a git repository, or git is missing. The tree shows no
        // decorations; record it at info level.
        void logFrontendError({
          level: 'info',
          message: `file-explorer git status unavailable for ${rootPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          source: 'FileExplorer:git-decorations'
        })
      })
  }, [rootPath])

  return useMemo(
    () => (rootPath ? buildGitDecorations(rootPath, statuses) : EMPTY_DECORATIONS),
    [rootPath, statuses]
  )
}
