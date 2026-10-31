import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { Bot } from '@/components/icons'
import { openAgentChatInOwnProject } from '@/lib/open-agent-chat'
import { useAcpStore } from '@/stores/acp-store'
import {
  type GithubChatLink,
  type GithubHandoffAction,
  hydrateGithubChatLinks,
  useGithubChatLinksStore
} from '@/stores/github-chat-links-store'

const ACTION_LABEL: Record<GithubHandoffAction, string> = {
  start: 'Start',
  ask: 'Ask',
  review: 'Review',
  fix_ci: 'Fix CI',
  resolve_comments: 'Resolve comments'
}

const NO_LINKS: GithubChatLink[] = []

/** Chats started from this item (newest first); each opens its chat. Chats that were deleted drop out. */
export function GithubLinkedChats({
  projectId,
  itemId
}: {
  projectId: string
  itemId: string
}): React.JSX.Element | null {
  useEffect(() => {
    void hydrateGithubChatLinks(projectId)
  }, [projectId])
  const links = useGithubChatLinksStore((s) => s.byProject[projectId] ?? NO_LINKS)
  const itemLinks = useMemo(
    () => links.filter((l) => l.itemId === itemId).reverse(),
    [links, itemId]
  )
  // Title per linked chat; undefined once the chat is gone (deleted, or a
  // rolled-back launch). Narrow so streaming in other chats does not re-render.
  const titles = useAcpStore(
    useShallow((s) =>
      itemLinks.map((l) => {
        if (s.sessions[l.sessionId]) return s.sessions[l.sessionId].title ?? ''
        return s.sessionIndex.find((e) => e.id === l.sessionId)?.title
      })
    )
  )
  const chats = itemLinks
    .map((link, i) => ({ link, title: titles[i] }))
    .filter((chat) => chat.title !== undefined)

  if (chats.length === 0) return null
  return (
    <section aria-labelledby="github-linked-chats" className="flex flex-col gap-1.5">
      <h2 id="github-linked-chats" className="text-sm font-medium text-foreground">
        Linked chats
      </h2>
      <ul className="flex flex-col gap-1">
        {chats.map(({ link, title }) => (
          <li key={link.sessionId}>
            <button
              type="button"
              onClick={() => openAgentChatInOwnProject(link.sessionId, 'github.linkedChats')}
              className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-left text-xs hover:bg-foreground/[0.03] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Bot size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium text-foreground">
                {ACTION_LABEL[link.action]}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {title || 'Agent chat'}
              </span>
              <span className="shrink-0 text-muted-foreground">Open</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
