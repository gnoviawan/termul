import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import {
  applyProjectClaudeAccount,
  CLAUDE_AGENT_CONFIG_ID,
  isClaudeSession,
  restartClaudeSession,
  switchProjectClaudeAccount
} from './claude-account-switch'

const { api } = vi.hoisted(() => ({ api: { setProjectAccount: vi.fn() } }))
vi.mock('@/lib/claude-accounts-api', () => ({ claudeAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const killAgent = vi.fn()
const retryCrashedSession = vi.fn()
const cancelPrompt = vi.fn()

const session = (id: string, o: { projectId?: string; agentId?: string; busy?: boolean } = {}) => ({
  id,
  agentId: o.agentId ?? `agent-${id}`,
  cwd: '/work',
  projectId: o.projectId ?? 'office',
  status: 'active' as const,
  title: null,
  activeTurn: Boolean(o.busy),
  openTurnId: o.busy ? 'turn-1' : null,
  modes: null,
  models: null,
  configOptions: [],
  lastError: null,
  createdAt: 1
})

const indexEntry = (id: string, agentConfigId: string) => ({
  id,
  agentId: `agent-${id}`,
  agentConfigId,
  title: id,
  cwd: '/work',
  projectId: 'office',
  createdAt: 1,
  lastActivityAt: 1,
  messageCount: 1,
  status: 'active' as const
})

beforeEach(() => {
  vi.clearAllMocks()
  killAgent.mockResolvedValue(undefined)
  retryCrashedSession.mockResolvedValue(undefined)
  cancelPrompt.mockImplementation(async (id: string) => {
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: { ...s.sessions[id], activeTurn: false, openTurnId: null } }
    }))
  })
  api.setProjectAccount.mockResolvedValue(undefined)
  useAcpStore.setState({
    ...FRESH,
    killAgent,
    retryCrashedSession,
    cancelPrompt,
    sessions: {
      c1: session('c1'),
      c2: session('c2', { busy: true }),
      other: session('other'),
      elsewhere: session('elsewhere', { projectId: 'side' })
    },
    sessionIndex: [
      indexEntry('c1', CLAUDE_AGENT_CONFIG_ID),
      indexEntry('c2', CLAUDE_AGENT_CONFIG_ID),
      indexEntry('other', 'acp-registry:gemini'),
      indexEntry('elsewhere', CLAUDE_AGENT_CONFIG_ID)
    ],
    sessionUsage: {
      c1: {
        used: 1,
        size: 10,
        baselineUsed: 1,
        updatedAt: 1,
        source: 'reported',
        rateLimit: {
          status: 'rejected',
          resetsAt: 1,
          kind: 'five_hour',
          percent: 100,
          overageInUse: false
        }
      }
    }
  } as never)
})

describe('claude account switch', () => {
  it('knows a managed Claude chat from its agent config', () => {
    const state = useAcpStore.getState()
    expect(isClaudeSession(state, 'c1')).toBe(true)
    expect(isClaudeSession(state, 'other')).toBe(false)
  })

  it('restarts an idle chat on a fresh process without resending, and clears the old limit', async () => {
    await expect(restartClaudeSession('c1')).resolves.toBe(true)
    expect(killAgent).toHaveBeenCalledWith('agent-c1')
    expect(retryCrashedSession).toHaveBeenCalledWith('c1', { resend: false })
    expect(killAgent.mock.invocationCallOrder[0]).toBeLessThan(
      retryCrashedSession.mock.invocationCallOrder[0]
    )
    expect(useAcpStore.getState().sessionUsage.c1?.rateLimit).toBeUndefined()
  })

  it('leaves a chat of another agent alone', async () => {
    await expect(restartClaudeSession('other')).resolves.toBe(false)
    expect(killAgent).not.toHaveBeenCalled()
  })

  it('waits for a busy chat to finish its turn', async () => {
    const restart = restartClaudeSession('c2')
    await Promise.resolve()
    expect(killAgent).not.toHaveBeenCalled()
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, c2: { ...s.sessions.c2, activeTurn: false, openTurnId: null } }
    }))
    await expect(restart).resolves.toBe(true)
    expect(retryCrashedSession).toHaveBeenCalledWith('c2', { resend: false })
  })

  it('cancels a held turn and resends when continuing after a limit', async () => {
    await restartClaudeSession('c2', { resend: true, cancelTurn: true })
    expect(cancelPrompt).toHaveBeenCalledWith('c2')
    expect(retryCrashedSession).toHaveBeenCalledWith('c2', { resend: true })
  })

  it('restarts only the Claude chats of the project, continuing the one that hit the limit', async () => {
    await applyProjectClaudeAccount('office', { continueSessionId: 'c2' })
    const restarted = retryCrashedSession.mock.calls.map(([id, o]) => [id, o.resend])
    expect(restarted).toEqual(
      expect.arrayContaining([
        ['c1', false],
        ['c2', true]
      ])
    )
    expect(restarted).toHaveLength(2)
  })

  it('saves the project account on the host before restarting', async () => {
    await switchProjectClaudeAccount('office', 'ab12')
    expect(api.setProjectAccount).toHaveBeenCalledWith('office', 'ab12')
    expect(api.setProjectAccount.mock.invocationCallOrder[0]).toBeLessThan(
      killAgent.mock.invocationCallOrder[0]
    )
  })
})
