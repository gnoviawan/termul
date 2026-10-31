import type { GithubRepoRef } from '@shared/types/github.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { create } from 'zustand'
import { persistenceApi } from '@/lib/api'
import { buildReadOnlyGuard, type GuardedItem } from '@/lib/github-handoff/read-only-guard'
import { logFrontendError } from '@/lib/log-api'

/** The agent hand-offs a GitHub issue or PR offers (CAP-5 to CAP-8). */
export type GithubHandoffAction = 'start' | 'ask' | 'review' | 'fix_ci' | 'resolve_comments'

/** Hand-offs whose chat is read-only: every turn carries the CAP-6 guard. */
const READ_ONLY_HANDOFFS: ReadonlySet<GithubHandoffAction> = new Set(['ask', 'review'])

/** A chat started from a GitHub item. `item` is enough to rebuild the read-only guard. */
export interface GithubChatLink {
  sessionId: string
  action: GithubHandoffAction
  /** {@link githubItemIdentity}: the same item from any working copy of the project. */
  itemId: string
  item: GuardedItem
  /** ISO 8601. */
  createdAt: string
}

/** Most links kept per project; the oldest drop first. */
const MAX_LINKS = 200

export function githubItemIdentity(repo: GithubRepoRef, number: number): string {
  return `${repo.host}/${repo.owner}/${repo.name}#${number}`
}

interface GithubChatLinksState {
  byProject: Record<string, GithubChatLink[]>
  link: (projectId: string, link: GithubChatLink) => void
  /** A launch placeholder became its real session: move its links along. */
  rekey: (projectId: string, fromSessionId: string, toSessionId: string) => void
  /** The launch failed before its chat existed. */
  unlink: (projectId: string, sessionId: string) => void
}

const hydrations = new Map<string, Promise<boolean>>()

function persist(projectId: string, links: GithubChatLink[]): void {
  void persistenceApi.write(PersistenceKeys.githubChatLinks(projectId), links).catch(() => {})
}

export const useGithubChatLinksStore = create<GithubChatLinksState>((set, get) => {
  const update = (projectId: string, fn: (links: GithubChatLink[]) => GithubChatLink[]): void => {
    const next = fn(get().byProject[projectId] ?? []).slice(-MAX_LINKS)
    set((state) => ({ byProject: { ...state.byProject, [projectId]: next } }))
    persist(projectId, next)
  }
  return {
    byProject: {},
    link: (projectId, link) => {
      update(projectId, (links) => [...links.filter((l) => l.sessionId !== link.sessionId), link])
    },
    rekey: (projectId, fromSessionId, toSessionId) => {
      if (fromSessionId === toSessionId) return
      update(projectId, (links) =>
        links.map((l) => (l.sessionId === fromSessionId ? { ...l, sessionId: toSessionId } : l))
      )
    },
    unlink: (projectId, sessionId) => {
      update(projectId, (links) => links.filter((l) => l.sessionId !== sessionId))
    }
  }
})

/**
 * Load a project's persisted links once, merged under any linked this run.
 * Idempotent: later calls share the first successful read. Resolves false
 * when the read failed, so a caller about to write links can stop instead of
 * replacing the persisted list.
 */
export function hydrateGithubChatLinks(projectId: string): Promise<boolean> {
  const existing = hydrations.get(projectId)
  if (existing) return existing
  const run = persistenceApi
    .read<GithubChatLink[]>(PersistenceKeys.githubChatLinks(projectId))
    .then((result) => {
      if (!result.success) {
        if (result.code === 'KEY_NOT_FOUND') return true
        // Not cached: the next call reads again.
        throw new Error(result.error)
      }
      if (!Array.isArray(result.data)) return true
      const persisted = result.data
      useGithubChatLinksStore.setState((state) => {
        const live = state.byProject[projectId] ?? []
        const liveIds = new Set(live.map((l) => l.sessionId))
        const merged = [...persisted.filter((l) => !liveIds.has(l.sessionId)), ...live]
        return { byProject: { ...state.byProject, [projectId]: merged.slice(-MAX_LINKS) } }
      })
      return true
    })
    .catch((err: unknown) => {
      hydrations.delete(projectId)
      void logFrontendError({
        level: 'warn',
        source: 'github.chatLinks.hydrate',
        message: `Could not read the GitHub chat links of project ${projectId}: ${String(err)}`
      })
      return false
    })
  hydrations.set(projectId, run)
  return run
}

/** Test-only: forget which projects were read. */
export function _resetGithubChatLinksForTesting(): void {
  hydrations.clear()
  useGithubChatLinksStore.setState({ byProject: {} })
}

export function linkOfSession(
  projectId: string | undefined,
  sessionId: string
): GithubChatLink | null {
  if (!projectId) return null
  const links = useGithubChatLinksStore.getState().byProject[projectId] ?? []
  return links.find((l) => l.sessionId === sessionId) ?? null
}

/** The CAP-6 guard text for a read-only GitHub chat, or null for any other chat. */
export function readOnlyGuardOfSession(
  projectId: string | undefined,
  sessionId: string
): string | null {
  const link = linkOfSession(projectId, sessionId)
  return link && READ_ONLY_HANDOFFS.has(link.action) ? buildReadOnlyGuard(link.item) : null
}
