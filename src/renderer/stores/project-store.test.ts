import { describe, expect, it } from 'vitest'
import { useProjectStore } from './project-store'

describe('useProjectStore tunnel presets', () => {
  it('creates projects with tunnel presets array', () => {
    const project = useProjectStore.getState().addProject('Test', 'blue')
    expect(project.tunnelPresets).toEqual([])
  })
})
