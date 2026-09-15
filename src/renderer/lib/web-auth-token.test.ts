import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authHeader, clearWebAuthToken, getWebAuthToken } from './web-auth-token'

function setUrl(pathAndQueryAndHash: string): void {
  // Relative URL: jsdom refuses cross-origin replaceState targets.
  window.history.replaceState({}, '', `/${pathAndQueryAndHash}`)
}

describe('web-auth-token', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setUrl('')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when no token is present anywhere', () => {
    expect(getWebAuthToken()).toBeNull()
    expect(authHeader()).toBeUndefined()
  })

  it('reads the #token= URL fragment and persists it to localStorage', () => {
    setUrl('#token=abc123')
    expect(getWebAuthToken()).toBe('abc123')
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('abc123')
  })

  it('falls back to the persisted token on later loads without the fragment', () => {
    setUrl('#token=abc123')
    getWebAuthToken()
    setUrl('')
    expect(getWebAuthToken()).toBe('abc123')
  })

  it('a fresh #token= fragment overrides the persisted one', () => {
    window.localStorage.setItem('termul.webAuthToken', 'old')
    setUrl('#token=new')
    expect(getWebAuthToken()).toBe('new')
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('new')
  })

  it('authHeader builds the Bearer header from the resolved token', () => {
    window.localStorage.setItem('termul.webAuthToken', 's3cret')
    expect(authHeader()).toEqual({ Authorization: 'Bearer s3cret' })
  })

  it('clearWebAuthToken removes the persisted token', () => {
    window.localStorage.setItem('termul.webAuthToken', 's3cret')
    clearWebAuthToken()
    expect(getWebAuthToken()).toBeNull()
    expect(authHeader()).toBeUndefined()
  })

  it('an empty #token= fragment is ignored', () => {
    setUrl('#token=')
    expect(getWebAuthToken()).toBeNull()
    expect(window.localStorage.getItem('termul.webAuthToken')).toBeNull()
  })

  it('a query-string ?token= is NOT honored (query leaks into logs/Referer)', () => {
    setUrl('?token=abc123')
    expect(getWebAuthToken()).toBeNull()
    expect(window.localStorage.getItem('termul.webAuthToken')).toBeNull()
    // The query string is left untouched — the server never accepted it.
    expect(window.location.search).toBe('?token=abc123')
  })

  it('strips the token from the URL after capture (no secret in history)', () => {
    setUrl('?foo=bar#token=abc123&view=x')
    expect(getWebAuthToken()).toBe('abc123')
    expect(window.location.search).toBe('?foo=bar')
    expect(window.location.hash).toBe('#view=x')
    // The persisted copy survives the strip — reloads keep working.
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('abc123')
  })

  it('a storage write failure still returns the fragment token for this session', () => {
    setUrl('#token=abc123')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    // Must not throw; the token applies to the current session even when it
    // cannot be persisted (a redacted failure is reported via log-api).
    expect(getWebAuthToken()).toBe('abc123')
    // The fragment was stripped despite the persistence failure.
    expect(window.location.hash).toBe('')
  })

  it('a storage read failure resolves to null instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(getWebAuthToken()).toBeNull()
  })
})
