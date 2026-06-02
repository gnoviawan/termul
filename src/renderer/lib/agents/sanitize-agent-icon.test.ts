import { describe, expect, it } from 'vitest'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'

describe('sanitizeInlineAgentSvg', () => {
  it('accepts viewBox on the root svg only', () => {
    const svg = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" /></svg>'
    expect(sanitizeInlineAgentSvg(svg)).toContain('viewBox="0 0 16 16"')
  })

  it('rejects nested viewBox without root viewBox', () => {
    const svg = '<svg width="16" height="16"><g viewBox="0 0 1 1"></g></svg>'
    expect(sanitizeInlineAgentSvg(svg)).toBeNull()
  })
})
