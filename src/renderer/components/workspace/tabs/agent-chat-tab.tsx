import { AgentBadge } from '@/components/chat/AgentBadge'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
import { isAgentConnected } from '@/components/chat/is-agent-connected'
import { CircleDot, Loader2, X as XIcon } from '@/components/icons'
import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { cn } from '@/lib/utils'
import {
  isEphemeralAcpSession,
  useAcpStore,
  useAgentIdentity,
  useSessionIndexTitle
} from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { TAB_CLOSE_BUTTON_CLASS, TabCloseReveal } from '../EditorTab'
import { handleTabAuxClick, TabContextMenu } from '../tab-context-menu'
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
  const isLaunchingSession = useAcpStore((s) => Boolean(s.launchingSessionIds[tab.sessionId]))
  const pendingPermission = useAcpStore((s) =>
    Object.values(s.pendingPermissions).some((permission) => permission.sessionId === tab.sessionId)
  )
  const pendingQuestion = useAcpStore((s) =>
    Object.values(s.pendingQuestions).some((question) => question.sessionId === tab.sessionId)
  )
  const closing = useAgentChatLifetimeStore((s) => Boolean(s.closingSessionIds[tab.sessionId]))
  const needsAttention = session
    ? agentChatNeedsAttention({
        projectId: session.projectId,
        sessionStatus: session.status,
        agentStatus,
        pendingPermission,
        pendingQuestion,
        ephemeral: isEphemeralAcpSession(session.id)
      })
    : false
  const { name: agentName } = useAgentIdentity(session?.agentId ?? null)
  // The persisted index entry carries the effective title (agent-pushed title,
  // first-message derivation, or "Untitled Chat N"). `session.title` stays null
  // until an event sets it, so fall through to the index entry for the label.
  // (Reused selector — the inline original was behaviorally identical: the
  // string return already suppressed unrelated sessionIndex rebuilds via
  // Object.is. Extraction is for reuse across call sites, not a behavior
  // change.)
  const indexTitle = useSessionIndexTitle(tab.sessionId)
  // Treat in-flight launcher handoff as connected so we don't flash a red
  // disconnected lamp on the optimistic placeholder chat.
  const connected = isLaunchingSession || isAgentConnected(session, agentStatus)
  const isClosed = session?.status === 'closed'
  const tabLabel = session?.title ?? indexTitle ?? agentName ?? 'Agent Chat'

  return (
    <TabContextMenu kind="agent-chat" onClose={onClose} isClosing={closing} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose, closing)}
        aria-label={`${tabLabel}${closing ? ', Closing' : ''}${needsAttention ? ', Needs you' : ''}`}
        className={cn(
          'group relative h-full px-3 flex items-center min-w-[120px] max-w-[200px] cursor-pointer select-none border-r border-border transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
          isDragging && 'opacity-50 scale-[0.98]',
          isDropTarget && dropPosition === 'before' && 'border-l-2 border-l-primary',
          isDropTarget && dropPosition === 'after' && 'border-r-2 border-r-primary'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {session ? (
            <>
              <AgentBadge
                agentId={session.agentId}
                showName={false}
                iconSize={12}
                className="shrink-0"
              />
              <span
                className={cn(
                  'min-w-0 truncate text-2xs font-medium',
                  isClosed && 'line-through opacity-60',
                  isActive ? 'text-foreground' : 'text-inherit'
                )}
                title={tabLabel}
              >
                {tabLabel}
              </span>
              {closing ? (
                <span
                  className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
                  title="Closing. This chat stops when the turn finishes."
                >
                  <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden />
                  <span className="sr-only">Closing</span>
                </span>
              ) : null}
              {needsAttention ? (
                <span
                  className="inline-flex size-3.5 shrink-0 items-center justify-center text-warning"
                  title="Needs you"
                >
                  <CircleDot size={12} aria-hidden />
                  <span className="sr-only">Needs you</span>
                </span>
              ) : null}
              <AgentConnectionLamp connected={connected} />
            </>
          ) : (
            <span className="min-w-0 truncate text-2xs font-medium">Agent Chat</span>
          )}
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={10} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}
