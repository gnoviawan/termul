/**
 * Ephemeral progress state for `git worktree add` while a chat launch (or the
 * New Worktree modal) waits on checkout. Drives the `WorktreeCreationCard`
 * rendered inside the chat timeline.
 *
 * - Desktop: `worktree_create` emits `acp:worktree_progress` events; a single
 *   `getAcpTransport().onEvent` subscription (`ensureTransportListener`)
 *   routes payloads into `handleEvent`.
 * - Web: `POST /worktree/create` with `streamProgress` returns an NDJSON
 *   stream on the same request; the facade calls `handleEvent` per frame —
 *   the session-scoped WS relay cannot be used because the chat session does
 *   not exist yet during launch.
 *
 * Ops are keyed by a renderer-generated `progressId`, so concurrent launches
 * and cross-window events cannot cross-talk: `handleEvent` ignores ids this
 * client never began. Ops are never persisted — the card lives for the
 * duration of one create call.
 */

import type { WorktreeProgressEvent } from '@shared/types/ipc.types'
import { create } from 'zustand'
import { getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'

export type WorktreeProgressStatus = 'preparing' | 'running' | 'done' | 'error'

export interface WorktreeOp {
  id: string
  branch?: string
  status: WorktreeProgressStatus
  /** Log lines shown in the card; capped at `MAX_PROGRESS_LINES`. */
  lines: string[]
  /** Latest `Updating files:` percent, or null before checkout starts. */
  percent: number | null
  /** Number of oldest lines dropped once `lines` hit the cap. */
  dropped: number
  error: string | null
}

const MAX_PROGRESS_LINES = 200
const UPDATING_FILES_PREFIX = 'Updating files:'
const UPDATING_FILES_RE = /Updating files:\s+(\d+)%/

interface WorktreeProgressState {
  ops: Record<string, WorktreeOp>
  /** Idempotent transport hookup for the desktop `acp:worktree_progress`
   * event. Must run before `worktree_create` is invoked so no early git line
   * is missed. No-op on web (progress arrives on the create response stream). */
  ensureTransportListener: () => void
  begin: (id: string, branch?: string) => void
  appendLine: (id: string, line: string) => void
  finish: (id: string, error?: string | null) => void
  handleEvent: (event: WorktreeProgressEvent) => void
  clear: (id: string) => void
}

let transportUnlisten: (() => void) | null = null

export const useWorktreeProgressStore = create<WorktreeProgressState>((set, get) => ({
  ops: {},

  ensureTransportListener: () => {
    if (!isTauriContext() || transportUnlisten) return
    transportUnlisten = getAcpTransport().onEvent<WorktreeProgressEvent>(
      'acp:worktree_progress',
      (event) => {
        get().handleEvent(event)
      }
    )
    void logFrontendError({
      level: 'info',
      source: 'worktree-progress-store',
      message: 'acp:worktree_progress listener registered'
    })
  },

  begin: (id, branch) =>
    set((prev) => ({
      ops: {
        ...prev.ops,
        [id]: { id, branch, status: 'preparing', lines: [], percent: null, dropped: 0, error: null }
      }
    })),

  appendLine: (id, line) =>
    set((prev) => {
      const op = prev.ops[id]
      if (!op) return prev
      let lines = op.lines
      let dropped = op.dropped
      // `Updating files: N%` is git's in-place counter — collapse consecutive
      // updates into the latest value instead of flooding the log.
      if (
        line.startsWith(UPDATING_FILES_PREFIX) &&
        lines.length > 0 &&
        lines[lines.length - 1].startsWith(UPDATING_FILES_PREFIX)
      ) {
        lines = [...lines.slice(0, -1), line]
      } else {
        lines = [...lines, line]
        if (lines.length > MAX_PROGRESS_LINES) {
          const overflow = lines.length - MAX_PROGRESS_LINES
          lines = lines.slice(overflow)
          dropped += overflow
        }
      }
      const percent = UPDATING_FILES_RE.exec(line)?.[1]
      return {
        ops: {
          ...prev.ops,
          [id]: {
            ...op,
            lines,
            dropped,
            percent: percent != null ? Number(percent) : op.percent,
            status: op.status === 'preparing' ? 'running' : op.status
          }
        }
      }
    }),

  finish: (id, error) =>
    set((prev) => {
      const op = prev.ops[id]
      if (!op) return prev
      return {
        ops: {
          ...prev.ops,
          [id]: {
            ...op,
            status: error ? 'error' : 'done',
            error: error ?? op.error
          }
        }
      }
    }),

  handleEvent: (event) => {
    const op = get().ops[event.progressId]
    if (!op) return // Unknown id — event belongs to a different client/launch.
    const { progressId, line } = event
    if (line === 'preparing') return // `begin` already set the preparing state.
    if (line === 'done') {
      get().finish(progressId)
    } else if (line.startsWith('error:')) {
      get().appendLine(progressId, line)
      get().finish(progressId, line.slice('error:'.length).trim())
    } else {
      get().appendLine(progressId, line)
    }
  },

  clear: (id) =>
    set((prev) => {
      if (!(id in prev.ops)) return prev
      const next = { ...prev.ops }
      delete next[id]
      return { ops: next }
    })
}))
