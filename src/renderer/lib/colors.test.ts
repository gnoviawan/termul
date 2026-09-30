import { describe, expect, it } from 'vitest'
import type { ProjectColor } from '@/types/project'
import { availableColors, getColorClasses, projectColors, statusBarColors } from './colors'

describe('project color tokens', () => {
  it('maps every project colour to project-* utilities', () => {
    for (const color of availableColors) {
      const classes = getColorClasses(color)
      expect(classes.bg).toBe(`bg-project-${color}`)
      expect(classes.text).toBe(`text-project-${color}`)
      expect(classes.shadow).toBe(`shadow-project-${color}/50`)
      expect(classes.border).toBe(`border-project-${color}`)
      expect(classes.borderMuted).toBe(`border-project-${color}/40`)
    }
  })

  it('maps the status bar to darker status-bar-* utilities', () => {
    for (const color of availableColors) {
      expect(statusBarColors[color]).toBe(`bg-status-bar-${color}`)
    }
  })

  it('does not use Tailwind palette primitives', () => {
    const blob = JSON.stringify({ projectColors, statusBarColors })
    expect(blob).not.toMatch(/gray-500|gray-600|blue-600|blue-500/)
  })

  it('covers every ProjectColor', () => {
    const keys = Object.keys(projectColors) as ProjectColor[]
    expect(keys.sort()).toEqual([...availableColors].sort())
  })
})
