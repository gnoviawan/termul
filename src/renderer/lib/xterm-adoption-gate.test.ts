import { describe, expect, it } from 'vitest'
import {
  XTERM_ADOPTION_GATE_RELEASE_CHECK,
  evaluateXtermAdoptionGate,
} from './xterm-adoption-gate'

describe('xterm-adoption-gate', () => {
  it('blocks promotion when any release-critical gate is missing', () => {
    const result = evaluateXtermAdoptionGate({
      approvalRecorded: false,
      continuityApproved: true,
      performanceApproved: false,
      workflowApproved: true,
      rollbackReady: false,
    })

    expect(result.approved).toBe(false)
    expect(result.baselinePath).toBe('xterm-5.5')
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No explicit approval recorded'),
        expect.stringContaining('Renderer/performance posture is not approved'),
        expect.stringContaining('Rollback readiness is not documented'),
      ]),
    )
  })

  it('approves promotion only when every gate passes', () => {
    const result = evaluateXtermAdoptionGate({
      approvalRecorded: true,
      continuityApproved: true,
      performanceApproved: true,
      workflowApproved: true,
      rollbackReady: true,
    })

    expect(result.approved).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(result.rationale).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Explicit approval'),
        expect.stringContaining('Continuity validation'),
        expect.stringContaining('Renderer/performance posture'),
        expect.stringContaining('Lifecycle-sensitive workflow validation'),
        expect.stringContaining('Rollback readiness'),
      ]),
    )
    expect(XTERM_ADOPTION_GATE_RELEASE_CHECK).toBe('npm run xterm:gate')
  })
})
