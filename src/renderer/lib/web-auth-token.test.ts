import { beforeEach, describe, expect, it } from 'vitest'

import { authHeader, clearWebAuthToken, getWebAuthToken } from './web-auth-token'

function setUrl(search: string): void {
  // Relative URL: jsdom refuses cross-origin replaceState targets.
  window.history.replaceState({}, '', `/${search}`)
}

describe('web-auth-token', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setUrl('')
  })

  it('returns null when no token is present anywhere', () => {
    expect(getWebAuthToken()).toBeNull()
    expect(authHeader()).toBeUndefined()
  })

  it('reads the ?token= URL param and persists it to localStorage', () => {
    setUrl('?token=abc123')
    expect(getWebAuthToken()).toBe('abc123')
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('abc123')
  })

  it('falls back to the persisted token on later loads without the param', () => {
    setUrl('?token=abc123')
    getWebAuthToken()
    setUrl('')
    expect(getWebAuthToken()).toBe('abc123')
  })

  it('a fresh ?token= overrides the persisted one', () => {
    window.localStorage.setItem('termul.webAuthToken', 'old')
    setUrl('?token=new')
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

  it('an empty ?token= param is ignored', () => {
    setUrl('?token=')
    expect(getWebAuthToken()).toBeNull()
    expect(window.localStorage.getItem('termul.webAuthToken')).toBeNull()
  })
  it('strips the token from the URL after capture (no secret in history)', () => {
    setUrl('?foo=bar&token=abc123#frag')
    expect(getWebAuthToken()).toBe('abc123')
    expect(window.location.search).toBe('?foo=bar')
    expect(window.location.hash).toBe('#frag')
    // The persisted copy survives the strip — reloads keep working.
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('abc123')
  })
})
