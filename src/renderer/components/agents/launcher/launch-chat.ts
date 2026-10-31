import {
  type PrepareLaunchWorktreeResult,
  prepareLaunchWorktree
} from '@/components/agents/launcher/prepare-launch-worktree'
import type { ContentBlock, SessionId } from '@/lib/acp-api'
import { randomUUID } from '@/lib/uuid'
import { useAcpStore } from '@/stores/acp-store'
import { agentChatTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'

type PlaceholderArgs = Parameters<
  ReturnType<typeof useAcpStore.getState>['createLaunchPlaceholder']
>[0]
type FinalizeArgs = Parameters<ReturnType<typeof useAcpStore.getState>['finalizeChatLaunch']>[0]

/** The checkout a chat starts in, once it is ready. */
export type LaunchCheckout = PrepareLaunchWorktreeResult

/** What the agent session starts with. */
export interface LaunchFirstTurn {
  /** The first turn, sent as soon as the session exists; null/absent opens the chat idle. */
  blocks?: ContentBlock[] | null
  pending?: FinalizeArgs['pending']
  /** Override the branch the chat records (a worktree moved onto a PR head). */
  worktreeBranch?: string
}

export interface ChatLaunchRequest {
  configId: string
  projectId: string
  /** The pane the chat tab opens in; absent means the focused pane. */
  paneId?: string
  /**
   * The checkout the chat runs in when no new worktree is made: the current
   * checkout, or a listed worktree already resolved by the caller.
   */
  checkout: LaunchCheckout
  /**
   * Make a new chat worktree first (only where worktrees are allowed). The
   * chat tab opens before it and streams git's progress.
   */
  newWorktree?: { projectRoot: string; baseBranch: string | null }
  /** Paint the placeholder (option snapshot, optimistic first turn). */
  placeholder?: Omit<PlaceholderArgs, 'cwd' | 'projectId' | 'worktreeProgressId'>
  /** Runs once the checkout is ready and before the agent session starts. */
  beforeStart?: (checkout: LaunchCheckout) => Promise<LaunchFirstTurn | undefined>
  /** The chat tab is open on the placeholder (runs synchronously inside {@link launchChat}). */
  onOpened?: (placeholderId: SessionId) => void
  onWorktreeCreating?: (creating: boolean) => void
  /** The new worktree failed. The tab is already closed and the placeholder discarded; the error is rethrown. */
  onWorktreeFailed?: (err: unknown) => void
  /** The placeholder became the real session (before the first turn is sent). */
  onAdopt?: (placeholderId: SessionId, sessionId: SessionId) => void
}

export interface ChatLaunch {
  placeholderId: SessionId
  /** Resolves to the real session id once `session/new` and the first turn are handed off. */
  started: Promise<SessionId>
}

/** Close a launch's chat tab and forget its placeholder (and its worktree progress card). */
export function rollbackLaunchPlaceholder(placeholderId: SessionId, progressId?: string): void {
  useWorkspaceStore.getState().removeTab(agentChatTabId(placeholderId))
  useAcpStore.getState().discardLaunchPlaceholder(placeholderId)
  if (progressId) useWorktreeProgressStore.getState().clear(progressId)
}

/**
 * The one chat launch sequence (spec-github-integration: no second launch
 * path). The agent launcher, its restart-after-update, and the GitHub
 * hand-offs all go through it: open the chat tab on a placeholder, make the
 * worktree while git's progress streams into the timeline, then start the
 * agent session in the ready checkout and hand off the first turn.
 *
 * The placeholder and tab exist when this returns, so a caller can update its
 * own UI in the same tick.
 */
export function launchChat(request: ChatLaunchRequest): ChatLaunch {
  const { configId, projectId, paneId, newWorktree } = request
  const progressId = newWorktree ? randomUUID() : undefined
  const store = useAcpStore.getState()
  const placeholderId = store.createLaunchPlaceholder({
    ...request.placeholder,
    cwd: newWorktree ? newWorktree.projectRoot : request.checkout.launchCwd,
    projectId,
    worktreeProgressId: progressId
  })
  useWorkspaceStore.getState().addAgentChatTab(placeholderId, paneId)
  request.onOpened?.(placeholderId)

  const started = (async (): Promise<SessionId> => {
    let checkout = request.checkout
    if (newWorktree) {
      request.onWorktreeCreating?.(true)
      try {
        checkout = await prepareLaunchWorktree({
          isolationMode: 'worktree',
          canUseWorktree: true,
          baseBranch: newWorktree.baseBranch,
          projectRoot: newWorktree.projectRoot,
          projectId,
          progressId
        })
      } catch (err) {
        rollbackLaunchPlaceholder(placeholderId, progressId)
        request.onWorktreeFailed?.(err)
        throw err
      } finally {
        request.onWorktreeCreating?.(false)
      }
    }
    const firstTurn = (await request.beforeStart?.(checkout)) ?? {}
    return useAcpStore.getState().finalizeChatLaunch({
      placeholderId,
      configId,
      cwd: checkout.launchCwd,
      projectId,
      mcpServers: undefined,
      pending: firstTurn.pending ?? null,
      initialText: null,
      initialBlocks: firstTurn.blocks && firstTurn.blocks.length > 0 ? firstTurn.blocks : null,
      adoptSession: (from, to) => {
        useWorkspaceStore.getState().remapAgentChatSession(from, to, paneId)
        request.onAdopt?.(from, to)
      },
      worktreePath: checkout.worktreePath,
      worktreeBranch: firstTurn.worktreeBranch ?? checkout.worktreeBranch
    })
  })()
  return { placeholderId, started }
}
