import { AgentBadge } from '@/components/chat/AgentBadge'
import { CircleDot } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useAgentIdentity, useSessionIndexTitle } from '@/stores/acp-store'
import { TabContextMenu } from '../tab-context-menu'
import { useAgentChatStatusSignals } from './agent-chat-status'
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
  const { session, needsAttention, turnBusy, unread } = useAgentChatStatusSignals(tab.sessionId)
  const { name: agentName } = useAgentIdentity(session?.agentId ?? null)
  // The persisted index entry carries the effective title (agent-pushed title,
  // first-message derivation, or "Untitled Chat N"). `session.title` stays null
  // until an event sets it, so fall through to the index entry for the label.
  const indexTitle = useSessionIndexTitle(tab.sessionId)
  // The trailing slot is a turn-lifecycle cue from the host's chat activity
  // (`useAgentChatStatusSignals`): a live turn spins (with the live edge), and
  // a turn end nobody has read leaves an unread dot unless this renderer shows
  // the chat, so this tab, the Chats panel and the phone drawer always agree.

  const isClosed = session?.status === 'closed'
  const tabLabel = session?.title ?? indexTitle ?? agentName ?? 'Agent Chat'
  // Slot priority: "needs you", then the running spinner, then the unread
  // dot — the single slot shows one cue, so the announced status matches
  // exactly what is visible.
  const showWorking = turnBusy
  const showUnread = !turnBusy && unread
  const activeStatus = needsAttention
    ? 'Needs you'
    : showWorking
      ? 'Working'
      : showUnread
        ? 'New activity'
        : null

  const statusNode = needsAttention ? (
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
    <TabContextMenu
      kind="agent-chat"
      onClose={onClose}
      reloadChatSessionId={tab.sessionId}
      {...bulkMenu}
    >
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
                'min-w-0 truncate text-xs font-medium leading-none opacity-60',
                isActive ? 'text-foreground' : 'text-inherit'
              )}
            >
              {tabLabel}
            </span>
          ) : undefined
        }
        after={
          <>
            {statusNode}
            {/* Persistent live region: announces status transitions (e.g.
                a turn starting on a background tab) without needing focus. */}
            <span className="sr-only" role="status">
              {activeStatus}
            </span>
          </>
        }
        alive={Boolean(showWorking)}
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
