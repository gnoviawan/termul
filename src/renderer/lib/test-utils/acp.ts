/**
 * Shared ACP fixtures for component/lib tests outside `stores/acp-store/`
 * (that suite keeps its own `testkit.ts` — do not merge them; this module
 * holds only the plain record factories other suites copy-pasted).
 */
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import type { AcpSession } from '@/stores/acp-store'

/**
 * Full `AcpSession` record — covers the union of fields the copied literals
 * set (`{id, agentId, cwd, projectId, status, title, activeTurn, openTurnId,
 * modes, models, configOptions, lastError, createdAt}` + extras).
 */
export function mockAcpSession(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: 'session-1',
    agentId: 'agent-1',
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
}

/**
 * Persisted session-index row (`sessionIndex` entries rendered by history /
 * chat-list components).
 */
export function mockSessionIndexEntry(
  overrides: Partial<SessionIndexEntry> = {}
): SessionIndexEntry {
  return {
    id: 'session-1',
    agentId: 'agent-1',
    title: 'Session 1',
    cwd: '/work',
    projectId: 'p1',
    createdAt: 0,
    lastActivityAt: 0,
    messageCount: 0,
    status: 'closed',
    ...overrides
  }
}
