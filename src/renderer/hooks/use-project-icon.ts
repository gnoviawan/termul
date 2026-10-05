import { useEffect, useRef } from 'react'
import { gitApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'

/**
 * Resolve project icons for every project that has a `path`
 * (spec-project-icon): a shared Rust resolver scans well-known local icon
 * files first, then derives a fetch URL from the parsed `git remote` — the
 * renderer never supplies a URL. `null` means "render the monogram".
 *
 * Runs on load and whenever the project list changes (activation refresh —
 * there is intentionally no live invalidation on remote-URL change). Two
 * staleness guards bound re-resolution: a persisted icon fresher than
 * `STALE_MS` (24 h, `icon.fetchedAt`) is skipped, and an in-memory attempt
 * clock skips repeat resolves of misses/errors within the same window so a
 * `null → clear → rescan` loop cannot form.
 *
 * Per-project monotonic tokens discard stale results: a project whose entry
 * is superseded (path change, delete+re-add, unmount) cannot be overwritten
 * by an earlier in-flight request. A RESOLVED `null` clears a stale icon;
 * a THROWN error (transport/path failure) retains the previous icon — the
 * persisted icon keeps rendering while refresh is in flight either way.
 *
 * There is deliberately no effect-cleanup cancel flag: every icon that lands
 * mutates `projects`, which re-runs this effect — a cleanup `cancelled`
 * would drop every slower still-in-flight resolve and the attempt clock
 * would suppress the retry, leaving remote icons permanently unresolved.
 * The keyed token alone decides whether a result still applies; a landing
 * for a deleted project is a harmless `updateProject` no-op.
 *
 * Transport-neutral: `gitApi.getProjectIcon` branches on `isTauriContext()`
 * (`project_icon_resolve` invoke vs `POST /project/icon`), so the hook covers
 * desktop, shared-live web clients, and `termul-server` browser/mobile.
 */

const STALE_MS = 24 * 60 * 60 * 1000

export function useProjectIcon(): void {
  const projects = useProjectStore((state) => state.projects)
  const isLoaded = useProjectStore((state) => state.isLoaded)
  const updateProject = useProjectStore((state) => state.updateProject)
  // Per-project monotonic request token — same shape as useProjectGitBranch
  // but keyed, since this hook resolves many projects concurrently.
  const tokenRef = useRef(new Map<string, number>())
  // Last resolve attempt per project id (epoch ms) + the path it was for —
  // bounds miss/error re-resolution and detects path changes.
  const attemptRef = useRef(new Map<string, { at: number; path: string }>())

  useEffect(() => {
    if (!isLoaded) return
    const now = Date.now()

    for (const project of projects) {
      if (!project.path) continue
      const last = attemptRef.current.get(project.id)
      if (last && last.path === project.path && now - last.at < STALE_MS) continue
      if (project.icon?.fetchedAt && now - project.icon.fetchedAt < STALE_MS) continue

      const token = (tokenRef.current.get(project.id) ?? 0) + 1
      tokenRef.current.set(project.id, token)
      attemptRef.current.set(project.id, { at: now, path: project.path })
      const { id, path } = project

      gitApi
        .getProjectIcon(path)
        .then((icon) => {
          if (tokenRef.current.get(id) !== token) return
          // A resolved `null` clears a stale icon (→ monogram); a hit stores
          // the payload plus the renderer-side staleness clock.
          updateProject(id, {
            icon: icon ? { ...icon, fetchedAt: Date.now() } : undefined
          })
        })
        .catch((error) => {
          if (tokenRef.current.get(id) !== token) return
          // Transport/path failure — retain whatever icon (if any) is stored.
          // Durable boundary log (no credentials/full URLs): AGENTS.md requires
          // renderer flows log via log-api.
          logFrontendError({
            level: 'warn',
            message: `useProjectIcon: getProjectIcon failed for project ${id}: ${error instanceof Error ? error.message : String(error)}`,
            source: 'useProjectIcon'
          })
        })
    }
  }, [projects, isLoaded, updateProject])
}
