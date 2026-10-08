import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import {
  type ChatIsolationContext,
  describeProjectSubtitle,
  useChatIsolationContext
} from './use-chat-isolation-context'

const initialProjects = useProjectStore.getState().projects

function seedProject(fields: { gitBranch?: string; isGitRepo?: boolean }): void {
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'termul', color: 'blue', path: '/work', ...fields }]
  })
}

describe('useChatIsolationContext', () => {
  afterEach(() => {
    useProjectStore.setState({ projects: initialProjects })
  })

  it('Local + branch: falls back to the project branch', () => {
    seedProject({ gitBranch: 'main', isGitRepo: true })
    const { result } = renderHook(() => useChatIsolationContext({ projectId: 'p1' }))

    expect(result.current).toEqual({
      isWorktree: false,
      isolationModeLabel: 'Local',
      isolationModeTitle: 'Agent edits files in your project folder directly',
      isolationBranch: 'main',
      isDetachedHead: false
    })
  })

  it('Worktree + branch: prefers the worktree branch and names the path in the title', () => {
    seedProject({ gitBranch: 'main', isGitRepo: true })
    const { result } = renderHook(() =>
      useChatIsolationContext({
        projectId: 'p1',
        worktreePath: '/work/.termul/worktrees/ab12',
        worktreeBranch: 'chat/ab12'
      })
    )

    expect(result.current).toEqual({
      isWorktree: true,
      isolationModeLabel: 'Worktree',
      isolationModeTitle: 'Agent works in a separate git worktree: /work/.termul/worktrees/ab12',
      isolationBranch: 'chat/ab12',
      isDetachedHead: false
    })
  })

  it('detached: a git project with no branch', () => {
    seedProject({ isGitRepo: true })
    const { result } = renderHook(() => useChatIsolationContext({ projectId: 'p1' }))

    expect(result.current.isolationBranch).toBeNull()
    expect(result.current.isDetachedHead).toBe(true)
  })

  it('a worktree without a branch is not detached', () => {
    seedProject({ isGitRepo: true })
    const { result } = renderHook(() =>
      useChatIsolationContext({ projectId: 'p1', worktreePath: '/work/.termul/worktrees/ab12' })
    )

    expect(result.current.isWorktree).toBe(true)
    expect(result.current.isolationBranch).toBeNull()
    expect(result.current.isDetachedHead).toBe(false)
  })

  it('non-git: no branch and not detached', () => {
    seedProject({ isGitRepo: false })
    const { result } = renderHook(() => useChatIsolationContext({ projectId: 'p1' }))

    expect(result.current.isolationModeLabel).toBe('Local')
    expect(result.current.isolationBranch).toBeNull()
    expect(result.current.isDetachedHead).toBe(false)
  })

  it('an unknown or missing project id resolves like a non-git project', () => {
    seedProject({ gitBranch: 'main', isGitRepo: true })
    const { result } = renderHook(() => useChatIsolationContext({ projectId: undefined }))

    expect(result.current.isolationBranch).toBeNull()
    expect(result.current.isDetachedHead).toBe(false)
  })
})

describe('describeProjectSubtitle', () => {
  const local: ChatIsolationContext = {
    isWorktree: false,
    isolationModeLabel: 'Local',
    isolationModeTitle: '',
    isolationBranch: 'main',
    isDetachedHead: false
  }

  it('worktree chat: project · branch · Worktree', () => {
    expect(
      describeProjectSubtitle('termul', {
        ...local,
        isWorktree: true,
        isolationModeLabel: 'Worktree',
        isolationBranch: 'chat/ab12'
      })
    ).toEqual({
      text: 'termul · chat/ab12 · Worktree',
      label: 'termul · chat/ab12, switch project'
    })
  })

  it('git local: project · branch · Local', () => {
    expect(describeProjectSubtitle('termul', local)).toEqual({
      text: 'termul · main · Local',
      label: 'termul · main, switch project'
    })
  })

  it('detached HEAD: project · Detached HEAD · Local', () => {
    expect(
      describeProjectSubtitle('termul', { ...local, isolationBranch: null, isDetachedHead: true })
    ).toEqual({
      text: 'termul · Detached HEAD · Local',
      label: 'termul · Detached HEAD, switch project'
    })
  })

  it('worktree with an unknown branch: project · Worktree', () => {
    expect(
      describeProjectSubtitle('termul', {
        ...local,
        isWorktree: true,
        isolationModeLabel: 'Worktree',
        isolationBranch: null
      })
    ).toEqual({ text: 'termul · Worktree', label: 'termul, switch project' })
  })

  it('non-git project: the name only', () => {
    expect(describeProjectSubtitle('termul', { ...local, isolationBranch: null })).toEqual({
      text: 'termul',
      label: 'termul, switch project'
    })
  })

  it('no project: "No project"', () => {
    expect(describeProjectSubtitle(undefined, local)).toEqual({
      text: 'No project',
      label: 'No project, switch project'
    })
  })
})
