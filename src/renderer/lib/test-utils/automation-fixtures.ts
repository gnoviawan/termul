/**
 * Typed views of the shared automation wire fixture
 * (`@shared/types/__fixtures__/automation.json`) for renderer tests.
 */

import wire from '@shared/types/__fixtures__/automation.json'
import type {
  Automation,
  AutomationRun,
  AutomationStep,
  Issue,
  RunPolicy
} from '@shared/types/automation.types'
import type { AutomationDetail } from '@/lib/automation-api'
import {
  parseAutomation,
  parseAutomationDetail,
  parseRun,
  parseStepList
} from '@/lib/automation-wire'

export const fixtureAutomation: Automation = parseAutomation(wire.automation)
export const fixturePolicy: RunPolicy = parseAutomationDetail({
  automation: wire.automation,
  issues: [],
  policy: wire.run_policy
}).policy
export const fixtureSteps: AutomationStep[] = parseStepList(wire.steps)

export function automationWith(overrides: Partial<Automation>): Automation {
  return { ...fixtureAutomation, ...overrides }
}

export function detailWith(
  overrides: Partial<Automation> = {},
  issues: Issue[] = []
): AutomationDetail {
  return { automation: automationWith(overrides), issues, policy: fixturePolicy }
}

/** A run of the fixture automation's own graph. */
export function runWith(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    ...parseRun(wire.runs[0]),
    graph: fixtureAutomation.graph,
    ...overrides
  }
}
