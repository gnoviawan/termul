import { useLayoutEffect, useRef, useState } from 'react'
import { AgentBadge } from '@/components/chat/AgentBadge'
import { CircleDot } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { cn } from '@/lib/utils'
import {
  isEphemeralAcpSession,
  useAcpStore,
  useAgentIdentity,
  useSessionIndexTitle
} from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

interface AgentChatTabInlineProps extends TabInlineProps {
  tab: { type: 'agent-chat'; id: string; sessionId: string }
}

export function AgentChatTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: AgentChatTabInlineProps) {
  const session = useAcpStore((s) => s.sessions[tab.sessionId])
  const agentStatus = useAcpStore((s) => (session ? s.agentStatus[session.agentId] : undefined))
  const pendingPermission = useAcpStore((s) =>
    Object.values(s.pendingPermissions).some((permission) => permission.sessionId === tab.sessionId)
  )
  const pendingQuestion = useAcpStore((s) =>
    Object.values(s.pendingQuestions).some((question) => question.sessionId === tab.sessionId)
  )
  const closing = useAgentChatLifetimeStore((s) => Boolean(s.closingSessionIds[tab.sessionId]))
  const ephemeral = session ? isEphemeralAcpSession(session.id) : false
  const needsAttention = session
    ? agentChatNeedsAttention({
        projectId: session.projectId,
        sessionStatus: session.status,
        agentStatus,
        pendingPermission,
        pendingQuestion,
        ephemeral
      })
    : false
  const { name: agentName } = useAgentIdentity(session?.agentId ?? null)
  // The persisted index entry carries the effective title (agent-pushed title,
  // first-message derivation, or "Untitled Chat N"). `session.title` stays null
  // until an event sets it, so fall through to the index entry for the label.
  const indexTitle = useSessionIndexTitle(tab.sessionId)
  // The trailing slot is a turn-lifecycle cue: a live turn spins (with the
  // live edge), and a turn that finishes while this tab is not the pane's
  // active tab leaves an unread dot until the tab becomes active. Only a
  // live, non-ephemeral session counts: closed/error sessions can carry
  // stale openTurnId/activeTurn flags (e.g. a crashed-session retry) and
  // warm-pool sessions are not chats.
  const liveSession =
    session != null && !ephemeral && session.status !== 'closed' && session.status !== 'error'
  const turnBusy = liveSession && sessionTurnBusy(session)
  const [unread, setUnread] = useState(false)
  const wasTurnBusy = useRef(false)

  // Unread is ephemeral by design — component-local, no store, no
  // persistence. The chip is keyed by tab.id and remounts on session remap,
  // pane moves, and project switches, so unread resetting on remount is the
  // intended scope. useLayoutEffect banks the dot before paint so the finish
  // commit swaps spinner → dot with no one-frame gap. `closing` wins the
  // slot, so a turn that ends during a close never banks a dot.
  useLayoutEffect(() => {
    const turnFinished = wasTurnBusy.current && !turnBusy
    wasTurnBusy.current = turnBusy
    if (isActive || !liveSession) {
      setUnread(false)
    } else if (turnFinished && !closing) {
      setUnread(true)
    }
  }, [isActive, turnBusy, closing, liveSession])

  const isClosed = session?.status === 'closed'
  const tabLabel = session?.title ?? indexTitle ?? agentName ?? 'Agent Chat'
  // Slot priority: the Closing spinner wins, then "needs you", then the
  // running spinner, then the unread dot — the single slot shows one cue,
  // so the announced status matches exactly what is visible.
  const showWorking = !closing && turnBusy
  const showUnread = liveSession && !closing && !turnBusy && unread
  const activeStatus = closing
    ? 'Closing'
    : needsAttention
      ? 'Needs you'
      : showWorking
        ? 'Working'
        : showUnread
          ? 'New activity'
          : null

  const statusNode = closing ? (
    <span
      title="Closing. This chat stops when the turn finishes."
      className="inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground"
    >
      <Spinner size={12} decorative />
      <span className="sr-only">Closing</span>
    </span>
  ) : needsAttention ? (
    <span
      title="Needs you"
      className="inline-flex size-3 shrink-0 items-center justify-center text-warning"
    >
      <CircleDot size={12} aria-hidden />
      <span className="sr-only">Needs you</span>
    </span>
  ) : showWorking ? (
    <span
      title="Working"
      className="inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground"
    >
      <Spinner size={12} decorative />
      <span className="sr-only">Working</span>
    </span>
  ) : showUnread ? (
    <span title="New activity" className="inline-flex size-3 shrink-0 items-center justify-center">
      <span className="size-2 rounded-full bg-primary-fill" aria-hidden />
      <span className="sr-only">New activity</span>
    </span>
  ) : null

  return (
    <TabContextMenu kind="agent-chat" onClose={onClose} isClosing={closing} {...bulkMenu}>
      <TabChrome
        isActive={isActive}
        isDragging={isDragging}
        isDropTarget={isDropTarget}
        dropPosition={dropPosition}
        onSelect={onSelect}
        onClose={onClose}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        ariaLabel={activeStatus ? `${tabLabel}, ${activeStatus}` : tabLabel}
        icon={
          session ? <AgentBadge agentId={session.agentId} showName={false} iconSize={12} /> : null
        }
        label={tabLabel}
        labelOverride={
          isClosed ? (
            <span
              title={tabLabel}
              className={cn(
                'min-w-0 truncate text-xs font-medium leading-none line-through opacity-60',
                isActive ? 'text-foreground' : 'text-inherit'
              )}
            >
              {tabLabel}
            </span>
          ) : undefined
        }
        after={
          session ? (
            <>
              {statusNode}
              {/* Persistent live region: announces status transitions (e.g.
                  a turn starting on a background tab) without needing focus. */}
              <span className="sr-only" role="status">
                {activeStatus}
              </span>
            </>
          ) : null
        }
        alive={Boolean(showWorking)}
        closeDisabled={closing}
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
