/**
 * Unit tests for the safe-uuid helper (CAP-1 / GH-587).
 *
 * Pins that the helper returns a valid RFC-4122 v4 UUID in a non-secure
 * context where `crypto.randomUUID` is undefined (plain-HTTP `termul-server`),
 * and that it delegates to the native API when available.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Silence the one-shot fallback warn so it never reaches a real fetch (the
// web log path POSTs to /log/frontend-error). The helper imports log-api
// directly; mocking it keeps the test hermetic.
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import { __resetUuidFallbackWarnForTesting, randomUUID } from '../uuid'

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('randomUUID (CAP-1 safe-uuid helper)', () => {
  // jsdom/node provides `crypto.randomUUID` natively. Capture and restore it
  // per-test so the fallback path can be exercised by shadowing it with
  // undefined (an own property on the instance, shadowing the prototype
  // method so `typeof crypto.randomUUID === 'function'` is false).
  let originalDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    __resetUuidFallbackWarnForTesting()
    originalDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  })

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(crypto, 'randomUUID', originalDescriptor)
    } else {
      // No own property originally — remove the shadow we added.
      // @ts-expect-error deleting a possibly-prototype-backed own prop
      delete crypto.randomUUID
    }
  })

  function shadowRandomUUIDAsUndefined(): void {
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true
    })
  }

  it('returns a valid RFC-4122 v4 UUID in a secure context (native path)', () => {
    // Native crypto.randomUUID is defined in the test environment.
    expect(typeof crypto.randomUUID).toBe('function')
    const id = randomUUID()
    expect(id).toMatch(V4_RE)
  })

  it('returns a valid RFC-4122 v4 UUID when crypto.randomUUID is undefined (fallback)', () => {
    shadowRandomUUIDAsUndefined()
    expect(typeof crypto.randomUUID).not.toBe('function')

    const id = randomUUID()

    // The fallback must be v4-shaped (not Math.random) so server-side id
    // matching (turn:<uuid>, WS frame ids) stays valid.
    expect(id).toMatch(V4_RE)
    expect(id.length).toBe(36)
  })

  it('produces unique ids across repeated fallback calls', () => {
    shadowRandomUUIDAsUndefined()
    const ids = new Set(Array.from({ length: 100 }, () => randomUUID()))
    // Astronomically unlikely to collide; the set guards the v4 bit-setting.
    expect(ids.size).toBe(100)
  })

  it('never throws when crypto.randomUUID is unavailable', () => {
    shadowRandomUUIDAsUndefined()
    expect(() => randomUUID()).not.toThrow()
  })
})
