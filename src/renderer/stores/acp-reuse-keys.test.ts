import { describe, expect, it } from 'vitest'
import {
  agentReuseKey,
  configIdFromReuseKey,
  detachedReuseKey,
  isDetachedReuseKey,
  parseReuseKey
} from './acp-reuse-keys'

describe('agentReuseKey / configIdFromReuseKey', () => {
  it('round-trips a config id with cwd (2-segment canonical key)', () => {
    const key = agentReuseKey('acp-registry:claude-acp', '/work/a')
    expect(key).toBe('acp-registry:claude-acp\0/work/a')
    expect(configIdFromReuseKey(key)).toBe('acp-registry:claude-acp')
  })

  it('trims the cwd segment', () => {
    expect(agentReuseKey('cfg-1', '  /work  ')).toBe('cfg-1\0/work')
  })

  it('recovers the configId from a key with no cwd segment', () => {
    expect(configIdFromReuseKey('cfg-1')).toBe('cfg-1')
  })

  it('recovers the configId from a detached key (split on first NUL)', () => {
    const key = detachedReuseKey(agentReuseKey('cfg-1', '/work'), 'agent-9')
    expect(key).toBe('cfg-1\0/work\0agent-9')
    expect(configIdFromReuseKey(key)).toBe('cfg-1')
  })
})

describe('detachedReuseKey / isDetachedReuseKey', () => {
  it('marks a detached key with a third segment', () => {
    const canonical = agentReuseKey('cfg-1', '/work')
    expect(isDetachedReuseKey(canonical)).toBe(false)
    const detached = detachedReuseKey(canonical, 'agent-9')
    expect(isDetachedReuseKey(detached)).toBe(true)
  })

  it('treats a key with no segments beyond configId as canonical', () => {
    expect(isDetachedReuseKey('cfg-1')).toBe(false)
  })
})

describe('parseReuseKey', () => {
  it('parses a canonical 2-segment key without a detached agent id', () => {
    expect(parseReuseKey('cfg-1\0/work')).toEqual({ configId: 'cfg-1', cwd: '/work' })
  })

  it('parses a detached 3-segment key with the detached agent id', () => {
    expect(parseReuseKey('cfg-1\0/work\0agent-9')).toEqual({
      configId: 'cfg-1',
      cwd: '/work',
      detachedAgentId: 'agent-9'
    })
  })

  it('keeps the cwd intact for detached keys (never misreads the agent id as a cwd)', () => {
    // The S1 regression: consuming `split('\0')[1]`-style segments handed a
    // detached key's agent id to prepareChat as the cwd.
    const parsed = parseReuseKey(detachedReuseKey(agentReuseKey('cfg-1', '/work'), 'agent-9'))
    expect(parsed.cwd).toBe('/work')
    expect(parsed.detachedAgentId).toBe('agent-9')
  })

  it('tolerates a key with only a config id (empty cwd)', () => {
    expect(parseReuseKey('cfg-1')).toEqual({ configId: 'cfg-1', cwd: '' })
  })
})
