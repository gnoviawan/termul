import { useCallback, useState } from 'react'
import { ChatEntryIcon } from '@/components/chat/ChatHistoryEntryRow'
import { ProjectIcon } from '@/components/ProjectIcon'
import { ChatRowTrail, type ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'
import type { ChatCardData } from '../chat-cards'
import { RAIL_HOVER_PANEL_PADDING, RAIL_PROJECT_ROW_HEIGHT, RAIL_ROW_GAP } from '../rail-layout'
import { useChatCardActions } from '../use-chat-card-actions'
import { isOpenChatCard, useChatLiveState, useProjectChats } from '../use-project-chats'
import {
  RailChatGroup,
  RailChatIcon,
  RailChatItem,
  RailChatList,
  RailChatRow,
  RailChatStatusDot,
  RailChatTitle,
  RailShowMore
} from './rail-chats'
import { RailDensityProvider, useRailCollapsed } from './rail-density'
import {
  RailHoverPanel,
  RailHoverPanelContent,
  RailHoverPanelProjectRow,
  RailHoverPanelTrigger
} from './rail-hover-panel'
import { logRailEvent } from './rail-log'

/**
 * The chat peek opens 4px above the project row that sits on top of the
 * chats, so its project row and chat rows line up with the Rail icons.
 */
const PEEK_ALIGN_OFFSET = -(RAIL_PROJECT_ROW_HEIGHT + RAIL_ROW_GAP + RAIL_HOVER_PANEL_PADDING)

interface RailProjectChatRowProps extends React.ComponentPropsWithoutRef<'button'> {
  card: ChatCardData
  open: boolean
  onOpenChat: (entry: ProjectChatEntry) => void
}

/**
 * One chat of the project: agent icon, title and the live trail. On the
 * collapsed Rail the trail gives way to a status dot on the icon; the status
 * stays in the accessible name.
 */
function RailProjectChatRow({
  card,
  open,
  onOpenChat,
  ...props
}: RailProjectChatRowProps): React.JSX.Element {
  const { entry } = card
  const collapsed = useRailCollapsed()
  const { liveState, statusWord } = useChatLiveState(entry.id)
  return (
    <RailChatRow
      open={open}
      onClick={() => onOpenChat(entry)}
      title={collapsed ? undefined : entry.title}
      aria-label={statusWord ? `${entry.title}, ${statusWord}` : entry.title}
      {...props}
    >
      <RailChatIcon>
        <ChatEntryIcon
          agentId={entry.agentId}
          agentConfigId={entry.agentConfigId}
          agents={entry.agents}
        />
        {collapsed && <RailChatStatusDot state={liveState} />}
      </RailChatIcon>
      <RailChatTitle>{entry.title}</RailChatTitle>
      {!collapsed && (
        <ChatRowTrail
          liveState={liveState}
          lastActivityAt={entry.lastActivityAt}
          closed={entry.status === 'closed'}
        />
      )}
    </RailChatRow>
  )
}

interface RailProjectChatsProps {
  project: Project
  /** Inside the chat peek: rows take the 6% hover fill of the hover panel. */
  peek?: boolean
  /** Peek only: the chat whose Rail icon the pointer is on (hover fill). */
  highlightedChatId?: string | null
  /** Runs after a row opens its chat. */
  onChatOpened?: (entry: ProjectChatEntry) => void
}

/**
 * The active project's chats in the Rail (Sidebar V2): the same cards as the
 * Chats list (scoped by the worktree pick, newest first), the first five, then
 * "Show N more". A click opens or focuses the chat.
 *
 * Collapsed Rail: one agent icon per chat at the same y, "···" for "Show N
 * more", and a hover peek next to the Rail with the project row and these
 * rows drawn expanded.
 * TODO(P4): chat search and import come back here.
 */
export function RailProjectChats({
  project,
  peek = false,
  highlightedChatId = null,
  onChatOpened
}: RailProjectChatsProps): React.JSX.Element | null {
  const collapsed = useRailCollapsed()
  const { cards, openChatId } = useProjectChats(project)
  const { onOpen } = useChatCardActions(project.id)
  const [hoveredChatId, setHoveredChatId] = useState<string | null>(null)
  const [peekOpen, setPeekOpen] = useState(false)

  const openChat = useCallback(
    (entry: ProjectChatEntry) => {
      logRailEvent(`${peek ? 'peek ' : ''}open chat ${entry.id}`)
      onOpen(entry)
      onChatOpened?.(entry)
    },
    [onOpen, onChatOpened, peek]
  )
  const closePeek = useCallback(() => setPeekOpen(false), [])

  if (cards.length === 0) return null
  const openIndex = cards.findIndex((card) => isOpenChatCard(card, openChatId))
  const group = (
    <RailChatGroup
      total={cards.length}
      pinnedIndex={openIndex === -1 ? undefined : openIndex}
      data-testid={peek ? 'rail-chat-peek-chats' : 'rail-project-chats'}
    >
      <RailChatList aria-label={`Chats in ${project.name}`}>
        {cards.map((card, index) => {
          const id = card.entry.id
          return (
            <RailChatItem key={id} index={index}>
              <RailProjectChatRow
                card={card}
                open={isOpenChatCard(card, openChatId)}
                onOpenChat={openChat}
                data-highlighted={(peek && id === highlightedChatId) || undefined}
                className={cn(
                  peek && 'hover:bg-foreground/[0.06] data-[highlighted]:bg-foreground/[0.06]'
                )}
                onPointerEnter={collapsed ? () => setHoveredChatId(id) : undefined}
                onPointerLeave={
                  collapsed
                    ? () => setHoveredChatId((current) => (current === id ? null : current))
                    : undefined
                }
              />
            </RailChatItem>
          )
        })}
      </RailChatList>
      <RailShowMore />
    </RailChatGroup>
  )
  if (!collapsed) return group

  return (
    <RailHoverPanel open={peekOpen} onOpenChange={setPeekOpen}>
      <RailHoverPanelTrigger asChild>{group}</RailHoverPanelTrigger>
      <RailHoverPanelContent alignOffset={PEEK_ALIGN_OFFSET} data-testid="rail-chat-peek">
        <RailDensityProvider density="expanded">
          <RailHoverPanelProjectRow
            icon={<ProjectIcon project={project} size={16} />}
            name={project.name}
          />
          <RailProjectChats
            project={project}
            peek
            highlightedChatId={hoveredChatId}
            onChatOpened={closePeek}
          />
        </RailDensityProvider>
      </RailHoverPanelContent>
    </RailHoverPanel>
  )
}
