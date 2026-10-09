import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionId } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { ChatStartHero } from './chat-start'

interface ChatEmptyStateProps {
  sessionId: SessionId
}

/**
 * An empty chat (no messages yet): the same start screen as the agent
 * launcher. This part is the hero above the composer; it fills the space
 * above, so with the starters below the composer (AgentChatPanel) the
 * composer sits in the middle of the pane.
 */
export function ChatEmptyState({ sessionId }: ChatEmptyStateProps): React.JSX.Element {
  const isMobileShell = useMobileWebShell()
  const projectId = useAcpStore((s) => s.sessions?.[sessionId]?.projectId)
  const projectName = useProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId)?.name : undefined
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-end px-6">
      <ChatStartHero
        projectLabel={projectName ?? 'this folder'}
        headingLevel={2}
        isMobileShell={isMobileShell}
      />
    </div>
  )
}
