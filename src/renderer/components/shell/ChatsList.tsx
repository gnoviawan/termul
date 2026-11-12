import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ImportChatsButton } from '@/components/chat/ImportChatsButton'
import type { ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import { SidebarSearchField } from '@/components/sidebar/sidebar-search-field'
import { conversationDeleteIds } from '@/lib/session-chain'
import { useAcpStore } from '@/stores/acp-store'
import { liveSwitchSources } from '@/stores/acp-store/shared-state'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { ChatCard } from './ChatCard'
import { buildChatCards, filterChatCards } from './chat-cards'
import { useChatCardActions } from './use-chat-card-actions'
import { useColumnWorkingCopy } from './use-column-working-copy'

/** First-paint card height; real heights are measured after mount. */
const ESTIMATED_CARD_HEIGHT = 44
const CARD_GAP = 2
const OVERSCAN = 6

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

/**
 * Chats tab body: a searchable, virtualised list of the active project's chats,
 * scoped by the worktree pick (never by the active tab). Only the cards in
 * view plus a small overscan are mounted, so a long history needs no pager.
 */
export function ChatsList({ project }: ChatsListProps): React.JSX.Element {
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const pick = useShellLayoutStore((s) => s.worktreePickByProject[project.id])
  const activeChatSessionId = useActiveChatSessionId()
  const { cwd } = useColumnWorkingCopy(project)
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    overscan: OVERSCAN,
    gap: CARD_GAP,
    getItemKey: (index) => filtered[index]?.entry.id ?? index
  })

  // Delete is irreversible: confirm first.
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectChatEntry | null>(null)
  // The open dialog's chat gained or lost sessions since it opened.
  const [deleteChanged, setDeleteChanged] = useState(false)
  const requestDelete = (entry: ProjectChatEntry | null): void => {
    setDeleteChanged(false)
    setDeleteConfirm(entry)
  }

  const cardButton = (index: number): HTMLElement | null =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-chat-card-index="${index}"]`) ?? null

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-chat-card-index]')
    if (!current) return
    const next = Number(current.dataset.chatCardIndex) + (event.key === 'ArrowDown' ? 1 : -1)
    if (next < 0 || next >= filtered.length) return
    event.preventDefault()
    const mounted = cardButton(next)
    if (mounted) {
      mounted.focus()
      return
    }
    virtualizer.scrollToIndex(next)
    requestAnimationFrame(() => cardButton(next)?.focus())
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1">
        <div className="min-w-0 flex-1">
          <SidebarSearchField
            size="sm"
            value={query}
            onChange={setQuery}
            placeholder="Search chats…"
            ariaLabel="Search chats"
            clearLabel="Clear chat search"
          />
        </div>
        <ImportChatsButton cwd={cwd} projectId={project.id} variant="icon" />
      </div>

      {cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-4 text-center text-xs text-muted-foreground opacity-70">
          No chats yet. Start one with the New chat button.
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: delegated Up/Down focus move between the cards' own buttons
        <div
          ref={scrollRef}
          data-testid="chats-list-scroll"
          onKeyDown={handleKeyDown}
          className="min-h-0 flex-1 overflow-y-auto pl-2 pr-1.5"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const card = filtered[item.index]
              if (!card) return null
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <ChatCard
                    card={card}
                    index={item.index}
                    isActive={
                      card.entry.id === activeChatSessionId ||
                      (activeChatSessionId !== null &&
                        (card.entry.chainIds?.includes(activeChatSessionId) ?? false))
                    }
                    actions={cardActions}
                    onRequestDelete={requestDelete}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        title="Delete chat"
        message={
          deleteConfirm
            ? deleteChanged
              ? `“${deleteConfirm.title}” changed while this dialog was open. Delete all ${(deleteConfirm.chainIds ?? [deleteConfirm.id]).length} of its sessions? This action cannot be undone.`
              : `Delete “${deleteConfirm.title}”? This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (!deleteConfirm) return
          // A switch completing after this dialog opened extends the chain:
          // re-resolve membership with the same rule `onDelete` applies, and
          // when it changed since the snapshot the user approved, refresh the
          // snapshot and require a new confirmation rather than silently
          // widening the delete.
          const { sessionIndex } = useAcpStore.getState()
          const fresh = conversationDeleteIds(sessionIndex, deleteConfirm.id, liveSwitchSources)
          const captured = deleteConfirm.chainIds ?? [deleteConfirm.id]
          const changed =
            fresh.length !== captured.length || fresh.some((id) => !captured.includes(id))
          if (changed) {
            setDeleteChanged(true)
            setDeleteConfirm({ ...deleteConfirm, chainIds: fresh })
            return
          }
          requestDelete(null)
          onDelete(deleteConfirm)
        }}
        onCancel={() => requestDelete(null)}
      />
    </div>
  )
}
