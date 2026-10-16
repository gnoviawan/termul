import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { projectIdForCwd } from './shared-state'

const project = (id: string, path: string): Project => ({ id, name: id, path }) as Project

describe('projectIdForCwd', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        project('work', '/code/work'),
        project('nested', '/code/work/packages/app'),
        project('win', 'C:\\code\\win\\')
      ]
    })
  })

  it('matches the project root and folders inside it', () => {
    expect(projectIdForCwd('/code/work')).toBe('work')
    expect(projectIdForCwd('/code/work/')).toBe('work')
    expect(projectIdForCwd('/code/work/src')).toBe('work')
    expect(projectIdForCwd('C:\\code\\win\\src')).toBe('win')
  })

  it('prefers the longest matching project root', () => {
    expect(projectIdForCwd('/code/work/packages/app/src')).toBe('nested')
  })

  it('does not match a sibling folder with the same prefix', () => {
    expect(projectIdForCwd('/code/workshop')).toBeNull()
    expect(projectIdForCwd('/elsewhere')).toBeNull()
  })
})
