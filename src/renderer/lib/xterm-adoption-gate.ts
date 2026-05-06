import { getXtermMigrationDefaultPath } from './xterm-migration'
import { XTERM_6_PACKAGE_LINE } from './xterm6-compat'

export interface AdoptionGateDecision {
  approved: boolean
  baselinePath: 'xterm-6.1'
  candidatePackageLine: typeof XTERM_6_PACKAGE_LINE
  blockers: string[]
  warnings: string[]
  rationale: string[]
}

export interface AdoptionGateInput {
  approvalRecorded: boolean
  continuityApproved: boolean
  performanceApproved: boolean
  workflowApproved: boolean
  rollbackReady: boolean
}

export const XTERM_ADOPTION_GATE_RELEASE_CHECK = 'npm run xterm:gate'

export function evaluateXtermAdoptionGate(input: AdoptionGateInput): AdoptionGateDecision {
  const blockers: string[] = []
  const warnings: string[] = []
  const rationale: string[] = []

  if (!input.approvalRecorded) {
    blockers.push('No explicit approval recorded for the current xterm 6.1 production baseline.')
  } else {
    rationale.push('Explicit approval for baseline replacement is recorded.')
  }

  if (!input.continuityApproved) {
    blockers.push('Continuity validation is not approved; project-switch continuity remains release-critical.')
  } else {
    rationale.push('Continuity validation meets the release-critical baseline gate.')
  }

  if (!input.performanceApproved) {
    blockers.push('Renderer/performance posture is not approved against the Story 3.2 threshold bands.')
  } else {
    rationale.push('Renderer/performance posture satisfies the documented threshold bands.')
  }

  if (!input.workflowApproved) {
    blockers.push('Lifecycle-sensitive workflow validation is not approved; IME/TUI/workflow risks remain.')
  } else {
    rationale.push('Lifecycle-sensitive workflow validation is approved.')
  }

  if (!input.rollbackReady) {
    blockers.push('Rollback readiness is not documented as acceptable.')
  } else {
    rationale.push('Rollback readiness is documented as acceptable.')
  }

  if (!input.approvalRecorded && (input.continuityApproved || input.performanceApproved || input.workflowApproved)) {
    warnings.push('Some supporting evidence exists, but baseline replacement is still blocked until explicit approval is recorded.')
  }

  return {
    approved: blockers.length === 0,
    baselinePath: getXtermMigrationDefaultPath(),
    candidatePackageLine: XTERM_6_PACKAGE_LINE,
    blockers,
    warnings,
    rationale,
  }
}
