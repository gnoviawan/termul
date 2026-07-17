import { describe, expect, it } from 'vitest'
import {
  getAcpPlanCompliance,
  planSupportHintMessage,
  registryIdFromAgentId,
  shouldShowPlanSupportHint
} from '@/lib/agents/acp-plan-compliance'

describe('acp-plan-compliance', () => {
  it('strips acp-registry prefix', () => {
    expect(registryIdFromAgentId('acp-registry:cursor')).toBe('cursor')
    expect(registryIdFromAgentId('cursor')).toBe('cursor')
  })

  it('marks cursor as non-standard and pi-acp as unsupported', () => {
    expect(getAcpPlanCompliance('acp-registry:cursor')).toBe('non_standard_extension')
    expect(getAcpPlanCompliance('pi-acp')).toBe('unsupported')
    expect(getAcpPlanCompliance('opencode')).toBe('unknown')
  })

  it('shows hint only for known non-compliant tiers without plan entries', () => {
    expect(shouldShowPlanSupportHint('unsupported', 0)).toBe(true)
    expect(shouldShowPlanSupportHint('non_standard_extension', 0)).toBe(true)
    expect(shouldShowPlanSupportHint('unknown', 0)).toBe(false)
    expect(shouldShowPlanSupportHint('unsupported', 2)).toBe(false)
  })

  it('returns hint copy for non-compliant tiers', () => {
    expect(planSupportHintMessage('unsupported')).toContain('not supported')
    expect(planSupportHintMessage('non_standard_extension')).toContain('session/update plan')
    expect(planSupportHintMessage('unknown')).toBeNull()
  })
})
