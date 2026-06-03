import { describe, expect, it } from 'vitest'
import type { AgentCapabilities } from '@/lib/acp-api'
import { decideResume } from './acp-resume-policy'

describe('decideResume', () => {
  it('returns local when not connected', () => {
    expect(decideResume({ connected: false, capabilities: { loadSession: true } })).toBe('local')
  })
  it('returns local when no capabilities', () => {
    expect(decideResume({ connected: true, capabilities: null })).toBe('local')
  })
  it('prefers load when loadSession is advertised', () => {
    const caps: AgentCapabilities = { loadSession: true, sessionCapabilities: { resume: {} } }
    expect(decideResume({ connected: true, capabilities: caps })).toBe('load')
  })
  it('uses resume when only resume is advertised', () => {
    const caps: AgentCapabilities = { loadSession: false, sessionCapabilities: { resume: {} } }
    expect(decideResume({ connected: true, capabilities: caps })).toBe('resume')
  })
  it('falls back to local when neither capability is present', () => {
    const caps: AgentCapabilities = { loadSession: false, sessionCapabilities: {} }
    expect(decideResume({ connected: true, capabilities: caps })).toBe('local')
  })
})
