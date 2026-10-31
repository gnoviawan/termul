/**
 * Pure-helper tests for the setup wizard's host normalization
 * (`normalizeSetupHost`): every spelling the server's `BindMode::parse`
 * accepts folds onto the two canonical bind hosts, and anything
 * unrecognized resolves to loopback — the safest reading.
 */

import { describe, expect, it, vi } from 'vitest'

// Owned by a parallel slice — the component module imports it eagerly, so
// the pure-helper tests stub the facade (no calls are made).
vi.mock('@/lib/web-setup-api', () => ({ webSetupApi: {} }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { normalizeSetupHost } from './ServerSetupWizard'

describe('normalizeSetupHost', () => {
  it.each([
    '0.0.0.0',
    'all',
    'any',
    'ALL',
    ' 0.0.0.0 '
  ])('maps public-bind spelling "%s" to 0.0.0.0', (input) => {
    expect(normalizeSetupHost(input)).toBe('0.0.0.0')
  })

  it.each([
    '127.0.0.1',
    'localhost',
    'loopback',
    'LOCALHOST',
    'bogus',
    ''
  ])('maps loopback/unrecognized spelling "%s" to 127.0.0.1', (input) => {
    expect(normalizeSetupHost(input)).toBe('127.0.0.1')
  })
})
