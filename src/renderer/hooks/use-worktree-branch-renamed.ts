import type { ChatHistoryWatchDelta } from '@shared/types/web-protocol.types'
import { useEffect } from 'react'
import { getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { reconcileProjectWorktrees, worktreeKey } from '@/lib/worktree-reconciler'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

/** Payload of a worktree branch rename (the `acp:worktree_branch_renamed` event on desktop, a `chat_history` delta on web). */
export interface WorktreeBranchRenamedPayload {
  worktreePath: string
  oldBranch: string
  newBranch: string
}

const EVENT_NAME = 'acp:worktree_branch_renamed'

function isPayload(value: unknown): value is WorktreeBranchRenamedPayload {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.worktreePath === 'string' &&
    record.worktreePath.length > 0 &&
    typeof record.newBranch === 'string' &&
    record.newBranch.length > 0
  )
}

/**
 * React to a host-side worktree branch rename (shell revamp story 16, CAP-5).
 * The host already rewrote `worktree_branch` for every session on the
 * worktree; the renderer only applies host facts:
 *
 * 1. live `useAcpStore` sessions whose `worktreePath` key matches get the new
 *    `worktreeBranch` (their persisted twin comes back through step 3),
 * 2. every project that lists the worktree, or whose folder contains it,
 *    reconciles its worktrees (the single `project.worktrees` writer),
 * 3. the session index is refetched.
 *
 * Failures log a warning WITHOUT branch names (they come from prompts).
 */
export function handleWorktreeBranchRenamed(payload: unknown): void {
  if (!isPayload(payload)) return
  const { worktreePath, newBranch } = payload
  const key = worktreeKey(worktreePath)

  useAcpStore.setState((state) => {
    let changed = false
    const sessions = { ...state.sessions }
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      if (!session.worktreePath || worktreeKey(session.worktreePath) !== key) continue
      if (session.worktreeBranch === newBranch) continue
      sessions[sessionId] = { ...session, worktreeBranch: newBranch }
      changed = true
    }
    return changed ? { sessions } : {}
  })

  for (const project of useProjectStore.getState().projects) {
    const listsWorktree = (project.worktrees ?? []).some((w) => worktreeKey(w.path) === key)
    const containsWorktree = !!project.path && isUnderKey(worktreeKey(project.path), key)
    if (!listsWorktree && !containsWorktree) continue
    void reconcileProjectWorktrees(project.id).catch((err: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: 'useWorktreeBranchRenamed.reconcile',
        message: `worktree reconcile after branch rename failed: ${String(err)}`
      })
    })
  }

  void useAcpStore
    .getState()
    .loadSessionIndex()
    .catch((err: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: 'useWorktreeBranchRenamed.loadSessionIndex',
        message: `session index refresh after branch rename failed: ${String(err)}`
      })
    })
}

/**
 * React to a host-side branch rename. On web the rename arrives as a delta of
 * the `chat_history` watch (the host sends no `seq = 0` event); the desktop
 * Tauri sink still emits `acp:worktree_branch_renamed`. Mounted next to
 * `useAcpHistory()` in both renderer roots.
 */
export function useWorktreeBranchRenamed(): void {
  useEffect(() => {
    const transport = getAcpTransport()
    if (transport.watches) {
      return transport.watches.subscribe<unknown, ChatHistoryWatchDelta>('chat_history', {
        onState: () => undefined,
        onDelta: (delta) => {
          if (delta?.event === 'worktree_branch_renamed') handleWorktreeBranchRenamed(delta.payload)
        }
      })
    }
    return transport.onEvent<WorktreeBranchRenamedPayload>(EVENT_NAME, handleWorktreeBranchRenamed)
  }, [])
}

/** Segment-bounded containment of normalized path keys. */
function isUnderKey(rootKey: string, key: string): boolean {
  if (key === rootKey) return true
  return key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`)
}
