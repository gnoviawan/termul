import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchAbort, launchChat } from './launch-chat'

const seams = vi.hoisted(() => ({
  prepareLaunchWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  reconcile: vi.fn(),
  log: vi.fn(),
  createLaunchPlaceholder: vi.fn(),
  discardLaunchPlaceholder: vi.fn(),
  finalizeChatLaunch: vi.fn(),
  addAgentChatTab: vi.fn(),
  removeTab: vi.fn(),
  clearProgress: vi.fn()
}))

vi.mock('./prepare-launch-worktree', () => ({
  prepareLaunchWorktree: seams.prepareLaunchWorktree
}))
vi.mock('@/lib/worktree-api', () => ({ worktreeApi: { remove: seams.removeWorktree } }))
vi.mock('@/lib/worktree-reconciler', () => ({ reconcileProjectWorktrees: seams.reconcile }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: seams.log }))
vi.mock('@/lib/uuid', () => ({ randomUUID: () => 'progress-1' }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: {
    getState: () => ({
      createLaunchPlaceholder: seams.createLaunchPlaceholder,
      discardLaunchPlaceholder: seams.discardLaunchPlaceholder,
      finalizeChatLaunch: seams.finalizeChatLaunch
    })
  }
}))
vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (id: string) => `chat-tab:${id}`,
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: seams.addAgentChatTab, removeTab: seams.removeTab })
  }
}))
vi.mock('@/stores/worktree-progress-store', () => ({
  useWorktreeProgressStore: { getState: () => ({ clear: seams.clearProgress }) }
}))

const WORKTREE = {
  launchCwd: '/repo/.termul/worktrees/ab12',
  worktreePath: '/repo/.termul/worktrees/ab12',
  worktreeBranch: 'chat/ab12'
}

function launchInWorktree(beforeStart: () => Promise<never>) {
  return launchChat({
    configId: 'claude',
    projectId: 'p1',
    checkout: { launchCwd: '/repo' },
    newWorktree: { projectRoot: '/repo', baseBranch: 'main' },
    beforeStart
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  seams.createLaunchPlaceholder.mockReturnValue('ph-1')
  seams.prepareLaunchWorktree.mockResolvedValue(WORKTREE)
  seams.removeWorktree.mockResolvedValue({ success: true, data: undefined })
  seams.reconcile.mockResolvedValue(undefined)
})

describe('launchChat', () => {
  it('removes the worktree it made and closes the tab when beforeStart calls the launch off', async () => {
    const { started } = launchInWorktree(async () => {
      throw new LaunchAbort('You cannot push to acme/app', 'GH_FORK_PUSH_BLOCKED')
    })

    await expect(started).rejects.toThrow('You cannot push to acme/app')
    expect(seams.removeTab).toHaveBeenCalledWith('chat-tab:ph-1')
    expect(seams.discardLaunchPlaceholder).toHaveBeenCalledWith('ph-1')
    expect(seams.clearProgress).toHaveBeenCalledWith('progress-1')
    expect(seams.removeWorktree).toHaveBeenCalledWith('/repo', '/repo/.termul/worktrees/ab12', true)
    expect(seams.reconcile).toHaveBeenCalledWith('p1')
    expect(seams.finalizeChatLaunch).not.toHaveBeenCalled()
    expect(seams.log).toHaveBeenLastCalledWith({
      level: 'warn',
      source: 'launch-chat.launchChat',
      message:
        'Chat launch ph-1 called off (code=GH_FORK_PUSH_BLOCKED): You cannot push to acme/app'
    })
  })

  it('keeps the worktree and the tab when beforeStart fails any other way', async () => {
    const { started } = launchInWorktree(async () => {
      throw new Error('attachment read failed')
    })

    await expect(started).rejects.toThrow('attachment read failed')
    expect(seams.removeWorktree).not.toHaveBeenCalled()
    expect(seams.removeTab).not.toHaveBeenCalled()
    expect(seams.log).toHaveBeenLastCalledWith({
      level: 'error',
      source: 'launch-chat.launchChat',
      message: 'Chat launch ph-1 failed: attachment read failed'
    })
  })

  it('logs where a launch opened', () => {
    seams.finalizeChatLaunch.mockResolvedValue('chat-1')
    launchChat({ configId: 'claude', projectId: 'p1', checkout: { launchCwd: '/repo' } })

    expect(seams.addAgentChatTab).toHaveBeenCalledWith('ph-1', undefined)
    expect(seams.log).toHaveBeenCalledWith({
      level: 'info',
      source: 'launch-chat.launchChat',
      message: 'Chat launch ph-1 opened for agent claude'
    })
  })
})
