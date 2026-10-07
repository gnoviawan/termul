/**
 * Shared helpers for the split acp-store test suites.
 *
 * `vi.mock()` blocks cannot live here — vitest hoists them per test file — so
 * each `acp-store/*.test.ts` replicates the module mocks it needs. This module
 * carries only the pure helpers/fixtures the split suites share.
 *
 * NOTE: do not import `@tauri-apps/*` here — this file is not covered by the
 * test-file override for `noRestrictedImports` (biome).
 */
import type { SessionConfigOption } from '@/lib/acp-api'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'

export const FRESH = {
  agents: {},
  agentStatus: {},
  agentConfigs: [],
  configToLiveAgent: {},
  warmingConfigs: {},
  preparedSessions: {},
  preparingChatKeys: {},
  prepareChatErrors: {},
  agentOptionsCache: {},
  sessionIndex: [],
  openingHistoryIds: {},
  restoringChatIds: {},
  launchingSessionIds: {},
  discoveredSessions: {},
  discoveringKeys: {},
  discoveredReopenContexts: {},
  mcpServers: [],
  sessions: {},
  activeSessionId: null,
  sessionUsage: {},
  messages: {},
  toolCalls: {},
  // CAP-2 (spec-in-chat-agent-switch): durable switch markers per session.
  agentSwitches: {},
  plans: {},
  commands: {},
  pendingPermissions: {},
  pendingQuestions: {},
  pendingElicitations: {},
  promptQueues: {},
  turnEndNotices: {},
  suppressQueueFlush: {},
  transportReconnecting: false,
  queuedProjectSwitchId: null,
  pendingBrowserOpen: {}
}

/**
 * Drain deferred turn-end callbacks (`setTimeout(0)`), which run after streamed
 * chunk handlers so macrotask-delivered chunks are not dropped.
 */
export async function flushTurnEnd(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function seedSession(sessionId: string, agentId: string, activeTurn = true): void {
  useAcpStore.setState({
    sessions: {
      [sessionId]: {
        id: sessionId,
        agentId,
        cwd: '/work',
        projectId: 'p1',
        status: 'active',
        title: null,
        activeTurn,
        openTurnId: activeTurn ? 'seed-turn' : null,
        modes: null,
        models: null,
        configOptions: [],
        lastError: null,
        createdAt: Date.now()
      }
    },
    messages: { [sessionId]: [] }
  })
}

// --- spec-acp-composer-option-fidelity: shared option fixtures ---------------

export const makeMode = (id: string): { id: string; name: string } => ({ id, name: id })

export const makeModel = (id: string): { modelId: string; name: string } => ({
  modelId: id,
  name: id
})

export const makeConfigOption = (
  id: string,
  currentValue: string,
  values: string[],
  category?: string
): SessionConfigOption => ({
  id,
  name: id,
  category: category ?? null,
  type: 'select',
  currentValue,
  options: values.map((v) => ({ value: v, name: v }))
})

/** Seed a live session with option state (and optional creation defaults). */
export function seedOptionsSession(
  sessionId: string,
  agentId: string,
  overrides: Partial<AcpSession> = {}
): void {
  useAcpStore.setState({
    sessions: {
      ...useAcpStore.getState().sessions,
      [sessionId]: {
        id: sessionId,
        agentId,
        cwd: '/work',
        projectId: 'p1',
        status: 'active',
        title: null,
        activeTurn: false,
        openTurnId: null,
        modes: null,
        models: null,
        configOptions: [],
        lastError: null,
        createdAt: 1,
        ...overrides
      }
    },
    messages: { ...useAcpStore.getState().messages, [sessionId]: [] }
  })
}
