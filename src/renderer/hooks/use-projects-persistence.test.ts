import { describe, expect, it } from 'vitest'
import { useProjectsLoader } from './use-projects-persistence'

describe('useProjects persistence', () => {
  it('module loads', () => {
    expect(typeof useProjectsLoader).toBe('function')
  })
})
