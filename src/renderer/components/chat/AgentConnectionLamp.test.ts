import { describe, expect, it } from 'vitest'

import { isAgentConnected } from './is-agent-connected'

describe('isAgentConnected', () => {
  it('returns true when session is open and agent is connected', () => {
    expect(isAgentConnected({ status: 'active' }, 'connected')).toBe(true)
  })

  it('returns false when session is closed', () => {
    expect(isAgentConnected({ status: 'closed' }, 'connected')).toBe(false)
  })

  it('returns false when agent status is not connected', () => {
    expect(isAgentConnected({ status: 'active' }, 'error')).toBe(false)
    expect(isAgentConnected({ status: 'active' }, 'idle')).toBe(false)
    expect(isAgentConnected({ status: 'active' }, 'spawning')).toBe(false)
  })

  it('returns false when session is missing', () => {
    expect(isAgentConnected(null, 'connected')).toBe(false)
    expect(isAgentConnected(undefined, 'connected')).toBe(false)
  })
})
