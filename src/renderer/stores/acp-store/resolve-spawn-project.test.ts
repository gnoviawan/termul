import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { resolveSpawnProject } from './shared-state'

const project = (id: string, path: string, worktrees: string[] = []): Project =>
  ({
    id,
    name: id,
    path,
    worktrees: worktrees.map((wt) => ({ id: wt, name: wt, branch: wt, path: wt, createdAt: '' }))
  }) as Project

const idFor = (cwd: string, projectId?: string): string | null =>
  resolveSpawnProject(cwd, projectId)?.id ?? null

describe('resolveSpawnProject', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        project('work', '/code/work', ['/trees/work-feature']),
        project('nested', '/code/work/packages/app'),
        project('win', 'C:\\code\\win\\')
      ]
    })
  })

  it('matches the project root and folders inside it', () => {
    expect(idFor('/code/work')).toBe('work')
    expect(idFor('/code/work/')).toBe('work')
    expect(idFor('/code/work/src')).toBe('work')
    expect(idFor('C:\\code\\win\\src')).toBe('win')
  })

  it('prefers the longest matching project root', () => {
    expect(idFor('/code/work/packages/app/src')).toBe('nested')
  })

  it('matches a worktree outside the project root', () => {
    expect(idFor('/trees/work-feature')).toBe('work')
  })

  it('does not match a sibling folder with the same prefix', () => {
    expect(idFor('/code/workshop')).toBeNull()
    expect(idFor('/elsewhere')).toBeNull()
  })

  it('takes an explicit project over the cwd, known or not', () => {
    expect(idFor('/code/work', 'nested')).toBe('nested')
    expect(idFor('/code/work', ' gone ')).toBe('gone')
  })
})
