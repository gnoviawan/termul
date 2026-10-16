import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: vi.fn(() => false) }))

import { seedProjectStore } from '@/lib/test-utils/store'
import type { Project } from '@/types/project'
import { agentReuseKey, detachedReuseKey } from '../acp-reuse-keys'
import { ephemeralSessionIds } from './ephemeral-ids'
import { _resetDefiniteSpawnRejectionsForTesting, ensureLiveAgent } from './shared-state'
import type { AcpState } from './types'

type Config = AcpState['agentConfigs'][number]

const WORK_KEY = agentReuseKey('cfg-1', '/work/app', 'proj-1')

function makeStore(config: Partial<Config> = {}) {
  const state = {
    agentConfigs: [
      {
        id: 'cfg-1',
        name: 'Claude',
        command: 'claude-acp',
        args: [],
        env: {},
        allowTerminal: false,
        ...config
      }
    ],
    configToLiveAgent: {} as Record<string, string>,
    agentStatus: {} as Record<string, string>,
    sessions: {} as Record<string, { id: string; agentId: string; status: string }>,
    warmingConfigs: {},
    spawnAgent: vi.fn(),
    killAgent: vi.fn(async () => {})
  }
  const get = () => state as unknown as AcpState
  const set = (fn: (s: AcpState) => Partial<AcpState> | AcpState) => {
    Object.assign(state, fn(state as unknown as AcpState))
  }
  return { state, get, set }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Work',
    color: 'blue',
    path: '/work/app',
    envVars: [{ key: 'CLAUDE_CONFIG_DIR', value: '/home/me/.claude-work', enabled: true }],
    ...overrides
  }
}

const spawnedEnv = (spawnAgent: ReturnType<typeof vi.fn>, call = 0): Record<string, string> =>
  spawnAgent.mock.calls[call]?.[0]?.env

describe('ensureLiveAgent — project environment variables (#1118)', () => {
  beforeEach(() => {
    _resetDefiniteSpawnRejectionsForTesting()
    seedProjectStore([])
  })

  it('spawns the agent with the env of the project that owns the cwd', async () => {
    seedProjectStore([project()])
    const { state, get, set } = makeStore()
    state.spawnAgent.mockResolvedValue('agent-1')

    expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-1')
    expect(spawnedEnv(state.spawnAgent)).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
  })

  it('resolves a worktree and a nested cwd to their project', async () => {
    seedProjectStore([
      project({
        worktrees: [{ id: 'wt', name: 'wt', branch: 'b', path: '/tmp/wt', createdAt: '' }]
      })
    ])
    const { state, get, set } = makeStore()
    state.spawnAgent.mockResolvedValue('agent-1')

    await ensureLiveAgent(get, set, 'cfg-1', '/tmp/wt')
    await ensureLiveAgent(get, set, 'cfg-1', '/work/app/packages/ui')
    expect(spawnedEnv(state.spawnAgent, 0)).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
    expect(spawnedEnv(state.spawnAgent, 1)).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
  })

  it('layers the agent config env on top of the project env and resolves $ references', async () => {
    seedProjectStore([
      project({
        envVars: [
          { key: 'CLAUDE_CONFIG_DIR', value: '/home/me/.claude-work', enabled: true },
          { key: 'TOKEN', value: 'from-project', enabled: true }
        ]
      })
    ])
    const { state, get, set } = makeStore({
      env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-agent', AGENT_TOKEN: '$TOKEN', MISSING: '$NOPE' }
    })
    state.spawnAgent.mockResolvedValue('agent-1')

    await ensureLiveAgent(get, set, 'cfg-1', '/work/app')
    expect(spawnedEnv(state.spawnAgent)).toEqual({
      CLAUDE_CONFIG_DIR: '/home/me/.claude-agent',
      TOKEN: 'from-project',
      AGENT_TOKEN: 'from-project'
    })
  })

  it('sends only the agent config env when no project owns the cwd', async () => {
    seedProjectStore([project()])
    const { state, get, set } = makeStore({ env: { FOO: 'bar' } })
    state.spawnAgent.mockResolvedValue('agent-1')

    await ensureLiveAgent(get, set, 'cfg-1', '/elsewhere')
    expect(spawnedEnv(state.spawnAgent)).toEqual({ FOO: 'bar' })
  })

  it('gives the next chat a fresh agent when the project env changed and leaves the old one running', async () => {
    seedProjectStore([project()])
    const { state, get, set } = makeStore()
    state.spawnAgent.mockResolvedValueOnce('agent-1').mockResolvedValueOnce('agent-2')

    expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-1')
    state.agentStatus['agent-1'] = 'connected'
    expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-1')
    expect(state.spawnAgent).toHaveBeenCalledTimes(1)

    seedProjectStore([
      project({ envVars: [{ key: 'CLAUDE_CONFIG_DIR', value: '/home/me/.claude-personal' }] })
    ])
    expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-2')
    expect(spawnedEnv(state.spawnAgent, 1)).toEqual({
      CLAUDE_CONFIG_DIR: '/home/me/.claude-personal'
    })
    expect(state.configToLiveAgent[WORK_KEY]).toBe('agent-2')
    // A session/new on agent-1 may still be in flight with no session in view.
    expect(state.killAgent).not.toHaveBeenCalled()
    expect(state.configToLiveAgent[detachedReuseKey(WORK_KEY, 'agent-1')]).toBe('agent-1')
  })

  it('does not stop a commit message generation running on the stale agent', async () => {
    seedProjectStore([project()])
    const { state, get, set } = makeStore()
    state.spawnAgent.mockResolvedValueOnce('agent-1').mockResolvedValueOnce('agent-2')
    expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-1')
    state.agentStatus['agent-1'] = 'connected'
    state.sessions = { 'commit-msg': { id: 'commit-msg', agentId: 'agent-1', status: 'active' } }
    ephemeralSessionIds.add('commit-msg')

    try {
      seedProjectStore([
        project({ envVars: [{ key: 'CLAUDE_CONFIG_DIR', value: '/home/me/.claude-personal' }] })
      ])
      expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-2')
      expect(state.killAgent).not.toHaveBeenCalled()
      expect(state.configToLiveAgent[detachedReuseKey(WORK_KEY, 'agent-1')]).toBe('agent-1')
    } finally {
      ephemeralSessionIds.delete('commit-msg')
    }
  })

  it('takes the env, the Account and the reuse key from the explicit project', async () => {
    seedProjectStore([
      project(),
      project({
        id: 'proj-2',
        path: '/other',
        envVars: [{ key: 'CLAUDE_CONFIG_DIR', value: '/home/me/.claude-other', enabled: true }]
      })
    ])
    const { state, get, set } = makeStore()
    state.spawnAgent.mockResolvedValue('agent-1')

    await ensureLiveAgent(get, set, 'cfg-1', '/work/app', { projectId: 'proj-2' })
    expect(spawnedEnv(state.spawnAgent)).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-other' })
    expect(state.spawnAgent.mock.calls[0]?.[1]).toBe('proj-2')
    expect(state.configToLiveAgent[agentReuseKey('cfg-1', '/work/app', 'proj-2')]).toBe('agent-1')
  })

  it('gives a worktree outside the project root the project Account and reuse key', async () => {
    seedProjectStore([
      project({
        worktrees: [{ id: 'wt', name: 'wt', branch: 'b', path: '/tmp/wt', createdAt: '' }]
      })
    ])
    const { state, get, set } = makeStore()
    state.spawnAgent.mockResolvedValue('agent-1')

    await ensureLiveAgent(get, set, 'cfg-1', '/tmp/wt')
    expect(spawnedEnv(state.spawnAgent)).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
    expect(state.spawnAgent.mock.calls[0]?.[1]).toBe('proj-1')
    expect(state.configToLiveAgent[agentReuseKey('cfg-1', '/tmp/wt', 'proj-1')]).toBe('agent-1')
  })

  it('keeps reusing a live agent it did not spawn itself (no recorded launch)', async () => {
    seedProjectStore([project()])
    const { state, get, set } = makeStore()
    state.configToLiveAgent[WORK_KEY] = 'agent-host'
    state.agentStatus['agent-host'] = 'connected'

    expect(await ensureLiveAgent(get, set, 'cfg-1', '/work/app')).toBe('agent-host')
    expect(state.spawnAgent).not.toHaveBeenCalled()
    expect(state.killAgent).not.toHaveBeenCalled()
  })
})
