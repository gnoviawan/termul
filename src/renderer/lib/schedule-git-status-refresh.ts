import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { useGitStatusStore } from '@/stores/git-status-store'

const DEBOUNCE_MS = 1000

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function shouldCompareCaseInsensitively(path: string, root: string): boolean {
  return (
    /^[a-zA-Z]:\//.test(path) ||
    /^[a-zA-Z]:\//.test(root) ||
    path.startsWith('//') ||
    root.startsWith('//')
  )
}

/** True when `filePath` is inside or equal to the git repo root `repoCwd`. */
export function isPathWithinRepo(filePath: string, repoCwd: string): boolean {
  const path = normalizePath(filePath)
  const root = normalizePath(repoCwd).replace(/\/$/, '')
  const caseInsensitive = shouldCompareCaseInsensitively(path, root)
  const comparablePath = caseInsensitive ? path.toLowerCase() : path
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`)
}

/** Distinct `cwd` values from open Git Changes tabs. */
export function collectOpenGitTabCwds(): string[] {
  const root = useWorkspaceStore.getState().root
  const cwds = new Set<string>()
  for (const leaf of getAllLeafPanes(root)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'git') {
        cwds.add(tab.cwd)
      }
    }
  }
  return [...cwds]
}

const pendingCwds = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced refresh of git status for every open Git Changes tab whose repo
 * contains `filePath`. No-op when no matching git tab is open.
 */
export function scheduleGitStatusRefreshForPath(filePath: string): void {
  let matched = false
  for (const cwd of collectOpenGitTabCwds()) {
    if (isPathWithinRepo(filePath, cwd)) {
      pendingCwds.add(cwd)
      matched = true
    }
  }
  if (!matched) return

  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    const refresh = useGitStatusStore.getState().refreshStatus
    const openCwds = new Set(collectOpenGitTabCwds())
    for (const cwd of pendingCwds) {
      if (openCwds.has(cwd)) {
        void refresh(cwd)
      }
    }
    pendingCwds.clear()
    flushTimer = null
  }, DEBOUNCE_MS)
}

/** Test-only reset of module-level debounce state. */
export function resetGitStatusRefreshSchedulerForTests(): void {
  pendingCwds.clear()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
}
