import { createContext, useContext } from 'react'
import { useShallow } from 'zustand/shallow'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { useAcpStore } from '@/stores/acp-store'
import { subagentChildCalls } from './subagent-strip'

/**
 * What subagent rows need from the chat they sit in: whose subagents they
 * are, and the one detail panel the chat owns. Rows in the transcript, the
 * status pill and the panel's own Activity all open that panel.
 */
export interface SubagentSurface {
  sessionId: string | null
  agentId: string | undefined
  filePathContext: FilePathResolutionContext | undefined
  /** The subagent the panel shows, if open. */
  openId: string | null
  /** The panel opens as a modal sheet (phone, narrow pane), not docked beside the chat. */
  opensDialog: boolean
  /**
   * Show `id` in the panel. `siblings` is the list the row sits in, for
   * "i of n" and arrow-key stepping. `nested` keeps the current subagent
   * underneath, so Back returns to it.
   */
  open: (id: string, siblings: readonly string[], options?: { nested?: boolean }) => void
}

/** Rows rendered outside a chat (tests, previews) show but cannot open a panel. */
const DETACHED: SubagentSurface = {
  sessionId: null,
  agentId: undefined,
  filePathContext: undefined,
  openId: null,
  opensDialog: false,
  open: () => {}
}

export const SubagentSurfaceContext = createContext<SubagentSurface>(DETACHED)

export function useSubagentSurface(): SubagentSurface {
  return useContext(SubagentSurfaceContext)
}

const NO_CALLS: readonly ToolCall[] = []

/** The tool calls a subagent made, live from the chat's store. */
export function useSubagentChildCalls(dispatchId: string): readonly ToolCall[] {
  const { sessionId } = useSubagentSurface()
  return useAcpStore(
    useShallow((s) =>
      sessionId ? subagentChildCalls(s.toolCalls[sessionId], dispatchId) : NO_CALLS
    )
  )
}
