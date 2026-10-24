/**
 * GPUIX twin of `components/shell/ChatsList.tsx`.
 *
 * The web list is a TanStack virtualizer: absolutely placed rows moved by
 * `transform: translateY`, sized from the scroll element's DOM height. GPUIX
 * paints no transforms and has no DOM height, so every card landed on the
 * first row. Here the cards go into a native `<virtual-list>`, which lays
 * rows out in flow and builds only those near the viewport. Card data,
 * search, Up/Down focus moves and the delete confirm are the web's.
 */

import { type KeyEvent, type PublicInstance, useGpuixRequired } from '@gpuix/react'
import { useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ChatCard } from '@/components/shell/ChatCard'
import { buildChatCards, filterChatCards } from '@/components/shell/chat-cards'
import { useChatCardActions } from '@/components/shell/use-chat-card-actions'
import type { ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import { SidebarSearchField } from '@/components/sidebar/sidebar-search-field'
import { useAcpStore } from '@/stores/acp-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { nodeFor, nodeOrNull } from '../../../compat/dom-node'
import { tw } from '../../../style/tw'

/** Unmeasured-card height hint; GPUI measures each card as it enters the viewport. */
const ESTIMATED_CARD_HEIGHT = 44
/** The web virtualizer's `gap`. */
const CARD_GAP = 2

/** Session id of the agent chat tab focused in the active pane, if any. */
function useActiveChatSessionId(): string | null {
  return useWorkspaceStore((s) => {
    const pane = findPaneById(s.root, s.activePaneId)
    if (pane?.type !== 'leaf') return null
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId)
    return tab?.type === 'agent-chat' ? tab.sessionId : null
  })
}

interface ChatsListProps {
  project: Project
}

export function ChatsList({ project }: ChatsListProps): React.JSX.Element {
  const renderer = useGpuixRequired()
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const pick = useShellLayoutStore((s) => s.worktreePickByProject[project.id])
  const activeChatSessionId = useActiveChatSessionId()
  const { onDelete, ...cardActions } = useChatCardActions(project.id)

  const agentNames = useMemo(
    () => new Map(agentConfigs.map((config) => [config.id, config.name])),
    [agentConfigs]
  )
  const cards = useMemo(
    () => buildChatCards({ sessionIndex, project, pick, agentNames }),
    [sessionIndex, project, pick, agentNames]
  )

  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterChatCards(cards, query), [cards, query])

  // Delete is irreversible: confirm first.
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectChatEntry | null>(null)

  const listRef = useRef<PublicInstance | null>(null)
  const cardButton = (index: number): HTMLElement | null => {
    const id = listRef.current?.id
    if (id === undefined) return null
    return nodeFor(id).querySelector(`[data-chat-card-index="${index}"]`) as HTMLElement | null
  }

  const onKeyDown = (event: KeyEvent): void => {
    if (event.key !== 'down' && event.key !== 'up') return
    const current = nodeOrNull(renderer.getFocusedElementId?.())?.closest('[data-chat-card-index]')
    if (!current) return
    const next = Number(current.dataset.chatCardIndex) + (event.key === 'down' ? 1 : -1)
    if (next < 0 || next >= filtered.length) return
    const mounted = cardButton(next)
    if (mounted) {
      mounted.focus()
      return
    }
    const id = listRef.current?.id
    if (id !== undefined) renderer.scrollToItem?.(id, next)
    requestAnimationFrame(() => cardButton(next)?.focus())
  }

  return (
    <div style={tw('flex min-h-0 flex-1 flex-col')}>
      <div style={tw('px-2 pb-1')}>
        <SidebarSearchField
          size="sm"
          value={query}
          onChange={setQuery}
          placeholder="Search chats…"
          ariaLabel="Search chats"
          clearLabel="Clear chat search"
        />
      </div>

      {cards.length === 0 ? (
        <div style={tw('flex flex-col items-center justify-center p-4 opacity-70')}>
          <text style={tw('text-center text-xs text-muted-foreground')}>
            No chats yet. Start one with the New chat button.
          </text>
        </div>
      ) : filtered.length === 0 ? (
        <div style={tw('px-3 py-4')}>
          <text style={tw('text-center text-xs text-muted-foreground')}>No matches.</text>
        </div>
      ) : (
        <div testId="chats-list-scroll" style={tw('flex min-h-0 flex-1 flex-col')} onKeyDown={onKeyDown}>
          <virtual-list
            ref={listRef}
            estimatedItemHeight={ESTIMATED_CARD_HEIGHT + CARD_GAP}
            style={{ ...tw('pl-2 pr-1.5'), flexGrow: 1, minHeight: 0 }}
          >
            {filtered.map((card, index) => (
              <div key={card.entry.id} style={{ paddingBottom: CARD_GAP }}>
                <ChatCard
                  card={card}
                  index={index}
                  isActive={card.entry.id === activeChatSessionId}
                  actions={cardActions}
                  onRequestDelete={setDeleteConfirm}
                />
              </div>
            ))}
          </virtual-list>
        </div>
      )}

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        title="Delete chat"
        message={
          deleteConfirm ? `Delete “${deleteConfirm.title}”? This action cannot be undone.` : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (deleteConfirm) {
            const id = deleteConfirm.id
            setDeleteConfirm(null)
            onDelete(id)
          }
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  )
}
