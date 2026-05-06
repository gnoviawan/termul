import { describe, expect, it } from 'vitest'
import {
  AUTOMATED_WORKFLOW_SCENARIOS,
  MANUAL_WORKFLOW_SCENARIOS,
  getWorkflowValidationMatrix,
  summarizeWorkflowValidationMatrix,
} from './xterm-workflow-validation'

describe('xterm-workflow-validation', () => {
  it('defines automated and manual lifecycle-sensitive scenarios', () => {
    expect(AUTOMATED_WORKFLOW_SCENARIOS.length).toBeGreaterThan(0)
    expect(MANUAL_WORKFLOW_SCENARIOS.length).toBeGreaterThan(0)
    expect(AUTOMATED_WORKFLOW_SCENARIOS.every((scenario) => scenario.mode === 'automated')).toBe(true)
    expect(MANUAL_WORKFLOW_SCENARIOS.every((scenario) => scenario.mode === 'manual')).toBe(true)
  })

  it('includes required risk areas from Story 3.3', () => {
    const matrix = getWorkflowValidationMatrix()
    const areas = new Set(matrix.map((scenario) => scenario.area))

    expect(areas.has('project-switching')).toBe(true)
    expect(areas.has('heavy-output')).toBe(true)
    expect(areas.has('resize-fit')).toBe(true)
    expect(areas.has('detached-output')).toBe(true)
    expect(areas.has('ime')).toBe(true)
    expect(areas.has('tui')).toBe(true)
    expect(areas.has('search')).toBe(true)
    expect(areas.has('links')).toBe(true)
    expect(areas.has('selection-copy')).toBe(true)
  })

  it('summarizes counts for automated/manual coverage', () => {
    expect(summarizeWorkflowValidationMatrix()).toEqual({
      total: AUTOMATED_WORKFLOW_SCENARIOS.length + MANUAL_WORKFLOW_SCENARIOS.length,
      automated: AUTOMATED_WORKFLOW_SCENARIOS.length,
      manual: MANUAL_WORKFLOW_SCENARIOS.length,
      canaryRequired: getWorkflowValidationMatrix().filter((scenario) => scenario.canaryRequired).length,
    })
  })
})
