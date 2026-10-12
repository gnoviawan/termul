import { describe, expect, it } from 'vitest'
import {
  HANDSHAKE_TIMEOUT_MS,
  jitteredBackoffMs,
  RECONNECT_MAX_MS,
  REQUEST_TIMEOUT_MS,
  requestTimeoutMs
} from './ws-transport-timing'

describe('jitteredBackoffMs', () => {
  it('scales the exponential delay by a ±25% factor', () => {
    expect(jitteredBackoffMs(0, 500, 8_000, () => 0)).toBe(375)
    expect(jitteredBackoffMs(0, 500, 8_000, () => 0.5)).toBe(500)
    expect(jitteredBackoffMs(0, 500, 8_000, () => 1)).toBe(625)
    expect(jitteredBackoffMs(2, 500, 8_000, () => 0)).toBe(1_500)
    expect(jitteredBackoffMs(2, 500, 8_000, () => 1)).toBe(2_500)
  })

  it('caps the base delay before applying jitter', () => {
    expect(jitteredBackoffMs(20, 500, RECONNECT_MAX_MS, () => 0.5)).toBe(RECONNECT_MAX_MS)
    expect(jitteredBackoffMs(20, 500, RECONNECT_MAX_MS, () => 1)).toBe(RECONNECT_MAX_MS * 1.25)
  })

  it('stays within bounds for any random sample', () => {
    for (let i = 0; i <= 100; i++) {
      const delay = jitteredBackoffMs(3, 500, 8_000, () => i / 100)
      expect(delay).toBeGreaterThanOrEqual(3_000)
      expect(delay).toBeLessThanOrEqual(5_000)
    }
  })
})

describe('requestTimeoutMs', () => {
  it('never undercuts the host bound of the long operations', () => {
    expect(requestTimeoutMs('install_acp_agent')).toBeGreaterThanOrEqual(320_000)
    expect(requestTimeoutMs('list_acp_catalog')).toBeGreaterThan(60_000)
    for (const type of [
      'create_session',
      'load_session',
      'resume_session',
      'switch_project'
    ] as const) {
      expect(requestTimeoutMs(type)).toBeGreaterThan(60_000) // server session cap + grace
    }
  })

  it('bounds the auth handshake request by the handshake timeout', () => {
    expect(requestTimeoutMs('authenticate')).toBe(HANDSHAKE_TIMEOUT_MS)
  })

  it('keeps the generic timer for quick commands', () => {
    expect(requestTimeoutMs('set_mode')).toBe(REQUEST_TIMEOUT_MS)
    expect(requestTimeoutMs('subscribe')).toBe(REQUEST_TIMEOUT_MS)
  })
})
