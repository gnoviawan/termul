/**
 * The transcript inputs `AgentChatPanel` hands `ChatMessageList`, from the
 * same store selectors and timeline builders. The worktree-progress and
 * agent-reload marker rows are not injected: the GPUIX client has no chat
 * panel around the list yet to own them.
 */

import { useMemo } from 'react'
import {
  buildTimeline,
  consolidateThoughtGroups,
  type TimelineItem
} from '@/components/chat/chat-timeline'
import type { SessionId } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

const EMPTY: never[] = []

export interface SessionTimeline {
  items: TimelineItem[]
  showRunningIndicator: boolean
  filePathContext: FilePathResolutionContext
  /** The store has a session record (opened or discovered). */
  known: boolean
}

export function useSessionTimeline(sessionId: SessionId): SessionTimeline {
  const session = useAcpStore((s) => s.sessions[sessionId])
  const messages = useAcpStore((s) => s.messages[sessionId] ?? EMPTY)
  const toolCalls = useAcpStore((s) => s.toolCalls[sessionId] ?? EMPTY)
  const agentSwitches = useAcpStore((s) => s.agentSwitches[sessionId] ?? EMPTY)
  const projects = useProjectStore((s) => s.projects)
  const filePathContext = useMemo(
    () => ({
      cwd: session?.cwd,
      projectRoot: session
        ? projects.find((p) => p.id === session.projectId)?.path || session.cwd
        : undefined
    }),
    [session, projects]
  )
  const items = useMemo(
    () => consolidateThoughtGroups(buildTimeline(messages, toolCalls, agentSwitches)),
    [messages, toolCalls, agentSwitches]
  )
  return {
    items,
    showRunningIndicator: Boolean(session?.activeTurn),
    filePathContext,
    known: Boolean(session)
  }
}
