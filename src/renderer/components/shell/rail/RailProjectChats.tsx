import { useCallback } from 'react'
import { ChatEntryIcon } from '@/components/chat/ChatHistoryEntryRow'
import { ChatRowTrail, type ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import type { Project } from '@/types/project'
import type { ChatCardData } from '../chat-cards'
import { useChatCardActions } from '../use-chat-card-actions'
import { isOpenChatCard, useChatLiveState, useProjectChats } from '../use-project-chats'
import {
  RailChatGroup,
  RailChatIcon,
  RailChatItem,
  RailChatList,
  RailChatRow,
  RailChatTitle,
  RailShowMore
} from './rail-chats'
import { logRailEvent } from './rail-log'

interface RailProjectChatRowProps {
  card: ChatCardData
  open: boolean
  onOpen: (entry: ProjectChatEntry) => void
}

/** One chat of the project: agent icon, title and the live trail. */
function RailProjectChatRow({ card, open, onOpen }: RailProjectChatRowProps): React.JSX.Element {
  const { entry } = card
  const { liveState, statusWord } = useChatLiveState(entry.id)
  return (
    <RailChatRow
      open={open}
      onClick={() => onOpen(entry)}
      title={entry.title}
      aria-label={statusWord ? `${entry.title}, ${statusWord}` : entry.title}
    >
      <RailChatIcon>
        <ChatEntryIcon
          agentId={entry.agentId}
          agentConfigId={entry.agentConfigId}
          agents={entry.agents}
        />
      </RailChatIcon>
      <RailChatTitle>{entry.title}</RailChatTitle>
      <ChatRowTrail
        liveState={liveState}
        lastActivityAt={entry.lastActivityAt}
        closed={entry.status === 'closed'}
      />
    </RailChatRow>
  )
}

/**
 * The active project's chats in the expanded Rail (Sidebar V2 P1): the same
 * cards as the Chats list (scoped by the worktree pick, newest first), the
 * first five, then "Show N more". A click opens or focuses the chat.
 * TODO(P4): chat search and import come back here.
 */
export function RailProjectChats({ project }: { project: Project }): React.JSX.Element | null {
  const { cards, openChatId } = useProjectChats(project)
  const { onOpen } = useChatCardActions(project.id)

  const openChat = useCallback(
    (entry: ProjectChatEntry) => {
      logRailEvent(`open chat ${entry.id}`)
      onOpen(entry)
    },
    [onOpen]
  )

  if (cards.length === 0) return null
  const openIndex = cards.findIndex((card) => isOpenChatCard(card, openChatId))
  return (
    <RailChatGroup
      total={cards.length}
      pinnedIndex={openIndex === -1 ? undefined : openIndex}
      data-testid="rail-project-chats"
    >
      <RailChatList aria-label={`Chats in ${project.name}`}>
        {cards.map((card, index) => (
          <RailChatItem key={card.entry.id} index={index}>
            <RailProjectChatRow
              card={card}
              open={isOpenChatCard(card, openChatId)}
              onOpen={openChat}
            />
          </RailChatItem>
        ))}
      </RailChatList>
      <RailShowMore />
    </RailChatGroup>
  )
}
