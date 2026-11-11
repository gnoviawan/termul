/**
 * Import slice: copy chats another client created (such as Claude Code CLI
 * chats the agent lists with `session/list`) into the durable chat history.
 * The host does the copy (`import_agent_session`); this slice finds the
 * candidates, drives the host one session at a time and refreshes the index.
 */

import type { StateCreator } from 'zustand'
import { acpApi } from '@/lib/acp-api'
import { AcpTransportError } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { agentReuseKey } from '../../acp-reuse-keys'
import { ensureLiveAgent, resolveSpawnProject, runsCurrentLaunch } from '../shared-state'
import type { AcpState, ImportSessionOutcome } from '../types'
import { withAuthRetry } from './agent'

type ImportSliceState = Pick<AcpState, 'listImportableSessions' | 'importAgentSessions'>

/**
 * Safety cap on `session/list` pages. A repeated cursor also ends the listing,
 * so the cap only stops a runaway agent.
 */
const MAX_LIST_PAGES = 200

export const createImportSlice: StateCreator<AcpState, [], [], ImportSliceState> = (set, get) => ({
  listImportableSessions: async (configId, cwd, projectId) => {
    const trimmedCwd = cwd.trim()
    // A live agent of this config and folder serves the listing as it is: the
    // import neither holds it nor detaches the one a chat runs on. One started
    // with an outdated launch (env or account) is not reused.
    const reuseKey = agentReuseKey(
      configId,
      trimmedCwd,
      resolveSpawnProject(trimmedCwd, projectId)?.id
    )
    const live = get().configToLiveAgent[reuseKey]
    const agentId =
      live &&
      get().agentStatus[live] === 'connected' &&
      runsCurrentLaunch(get(), live, configId, trimmedCwd, projectId)
        ? live
        : await ensureLiveAgent(get, set, configId, trimmedCwd, { projectId })
    if (!agentId) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.importSessions.list',
        message: 'Agent unavailable: no sessions listed for import'
      })
      return { status: 'unavailable' }
    }
    const capabilities = get().agents[agentId]?.capabilities
    if (!capabilities?.loadSession || !capabilities.sessionCapabilities?.list) {
      void logFrontendError({
        level: 'info',
        source: 'acp.importSessions.list',
        message: 'Agent cannot list and load sessions: import is not offered'
      })
      return { status: 'unsupported' }
    }

    const known = new Set(get().sessionIndex.map((entry) => entry.id))
    const sessions = []
    const seen = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let truncated = false
    for (let page = 0; ; page++) {
      if (page === MAX_LIST_PAGES) {
        truncated = true
        break
      }
      const res = await withAuthRetry(get, agentId, 'session/list', 'text', () =>
        acpApi.listSessions(agentId, trimmedCwd, cursor)
      )
      for (const info of res.sessions ?? []) {
        if (seen.has(info.sessionId)) continue
        seen.add(info.sessionId)
        if (!known.has(info.sessionId)) sessions.push(info)
      }
      if (res.nextCursor == null) break
      // A repeated cursor would loop forever.
      if (cursors.has(res.nextCursor)) {
        truncated = true
        break
      }
      cursors.add(res.nextCursor)
      cursor = res.nextCursor
    }
    if (truncated) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.importSessions.list',
        message: `Stopped listing agent sessions after ${seen.size}: the agent kept returning a cursor`
      })
    }
    if (get().agentStatus[agentId] !== 'connected') {
      void logFrontendError({
        level: 'warn',
        source: 'acp.importSessions.list',
        message: 'Agent disconnected while listing sessions for import'
      })
      return { status: 'unavailable' }
    }
    void logFrontendError({
      level: 'info',
      source: 'acp.importSessions.list',
      message: `Listed ${seen.size} agent session(s), ${sessions.length} not yet in the chat history`
    })
    return { status: 'ready', agentId, sessions }
  },

  importAgentSessions: async ({ agentId, cwd, projectId, sessions, onProgress }) => {
    const outcomes: ImportSessionOutcome[] = []
    for (const info of sessions) {
      try {
        const updatedAt = info.updatedAt ? Date.parse(info.updatedAt) : Number.NaN
        // The host loads the session on the agent, so an expired login is
        // recovered the way a chat's own `session/load` recovers it. A failed
        // import leaves nothing behind, which makes the retry safe.
        await withAuthRetry(get, agentId, 'session/load', 'text', () =>
          acpApi.importAgentSession({
            agentId,
            sessionId: info.sessionId,
            cwd: info.cwd || cwd,
            title: info.title,
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
            projectId: projectId || undefined
          })
        )
        outcomes.push({ sessionId: info.sessionId, status: 'imported' })
      } catch (error) {
        if (error instanceof AcpTransportError && error.code === 'duplicate') {
          outcomes.push({ sessionId: info.sessionId, status: 'duplicate' })
        } else {
          outcomes.push({
            sessionId: info.sessionId,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
      onProgress?.(outcomes.length)
    }
    const imported = outcomes.filter((o) => o.status === 'imported').length
    const failed = outcomes.filter((o) => o.status === 'failed').length
    void logFrontendError({
      level: failed > 0 ? 'warn' : 'info',
      source: 'acp.importSessions.import',
      message: `Imported ${imported} of ${sessions.length} agent session(s); ${failed} failed`
    })
    // Desktop gets no `chat_history` watch delta: reread the index so the
    // imported chats show up.
    await get()
      .loadSessionIndex()
      .catch((error: unknown) => {
        void logFrontendError({
          level: 'warn',
          source: 'acp.importSessions.refresh',
          message: `Chat history refresh after import failed: ${String(error)}`
        })
      })
    return outcomes
  }
})
