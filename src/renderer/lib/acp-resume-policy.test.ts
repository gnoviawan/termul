import { describe, expect, it } from 'vitest'
import type { AgentCapabilities } from '@/lib/acp-api'
import { decideResume, resumeMissesSession } from './acp-resume-policy'

describe('decideResume', () => {
  it('returns local when not connected', () => {
    expect(decideResume({ connected: false, capabilities: { loadSession: true } })).toBe('local')
  })
  it('returns local when no capabilities', () => {
    expect(decideResume({ connected: true, capabilities: null })).toBe('local')
  })
  it('prefers resume when both load and resume are advertised', () => {
    const caps: AgentCapabilities = { loadSession: true, sessionCapabilities: { resume: {} } }
    expect(decideResume({ connected: true, capabilities: caps })).toBe('resume')
  })
  it('uses load when only loadSession is advertised', () => {
    const caps: AgentCapabilities = { loadSession: true }
    expect(decideResume({ connected: true, capabilities: caps })).toBe('load')
  })
  it('treats a missing-session resume error as a one-shot load fallback', () => {
    expect(resumeMissesSession(new Error('Session not found'))).toBe(true)
    expect(resumeMissesSession('no such session: sess-1')).toBe(true)
    expect(resumeMissesSession(new Error('ACP_AUTH_REQUIRED: Authentication required'))).toBe(false)
    expect(resumeMissesSession(new Error('ACP_REOPEN_TURN_ACTIVE: session sess-1'))).toBe(false)
    expect(resumeMissesSession(new Error('session/resume timed out after 30s'))).toBe(false)
    expect(resumeMissesSession(new Error('Internal error'))).toBe(false)
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
