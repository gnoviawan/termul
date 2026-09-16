import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logFrontendError } from './log-api'
import { authHeader, clearWebAuthToken, getWebAuthToken } from './web-auth-token'

vi.mock('./log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

function setUrl(pathAndQueryAndHash: string): void {
  // Relative URL: jsdom refuses cross-origin replaceState targets.
  window.history.replaceState({}, '', `/${pathAndQueryAndHash}`)
}

describe('web-auth-token', () => {
  beforeEach(() => {
    // Reset the module-level session cache too (it survives storage clears).
    clearWebAuthToken()
    window.localStorage.clear()
    setUrl('')
    vi.mocked(logFrontendError).mockClear()
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
    // The session cache keeps the token for LATER resolutions in this
    // session — without it the strip above would strand the client.
    expect(getWebAuthToken()).toBe('abc123')
    expect(authHeader()).toEqual({ Authorization: 'Bearer abc123' })
    // The failure was reported exactly once (cached re-resolutions do not
    // retry the failing write).
    expect(logFrontendError).toHaveBeenCalledTimes(1)
  })

  it('prefers the session-cached fragment token over a stale persisted value', () => {
    window.localStorage.setItem('termul.webAuthToken', 'old')
    // The fragment bootstrap cannot be persisted (storage write fails), so
    // localStorage keeps the STALE token…
    setUrl('#token=new')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(getWebAuthToken()).toBe('new')
    vi.restoreAllMocks()
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('old')
    // …but the fresher session-cached fragment token wins on later calls.
    expect(getWebAuthToken()).toBe('new')
  })

  it('a storage read failure still resolves the session-cached token', () => {
    setUrl('#token=abc123')
    expect(getWebAuthToken()).toBe('abc123')
    // Persistence is lost AFTER the bootstrap (storage evicted/disabled).
    window.localStorage.clear()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(getWebAuthToken()).toBe('abc123')
  })

  it('clearWebAuthToken drops the session cache as well as storage', () => {
    // Cache a token with persistence unavailable so ONLY the session cache
    // holds it.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    setUrl('#token=abc123')
    expect(getWebAuthToken()).toBe('abc123')
    vi.restoreAllMocks()
    clearWebAuthToken()
    expect(getWebAuthToken()).toBeNull()
    expect(authHeader()).toBeUndefined()
  })

  it('a storage read failure resolves to null instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(getWebAuthToken()).toBeNull()
  })
})

describe('insecure-transport warning', () => {
  // jsdom's window.location is a configurable accessor in this harness, so
  // tests can swap the origin; restore the real descriptor after each test.
  const realLocation = Object.getOwnPropertyDescriptor(window, 'location')

  function stubLocation(protocol: string, hostname: string): void {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol, hostname, hash: '', pathname: '/', search: '' }
    })
  }

  beforeEach(() => {
    // Fresh module state per test: the once-per-session latch is module
    // state, so re-import after resetting the registry.
    vi.resetModules()
    // The mocked log-api instance is shared across the file — clear calls
    // from earlier tests (e.g. storage-failure reports above).
    vi.mocked(logFrontendError).mockClear()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  afterEach(() => {
    if (realLocation) Object.defineProperty(window, 'location', realLocation)
    vi.restoreAllMocks()
  })

  it('warns loudly once per session on a plaintext non-loopback origin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.localStorage.setItem('termul.webAuthToken', 's3cret')
    stubLocation('http:', '192.168.1.20')
    // Dynamic import: vi.resetModules (beforeEach) clears the registry so the
    // once-per-session latch starts fresh per test.
    const mod = await import('./web-auth-token')
    expect(mod.getWebAuthToken()).toBe('s3cret')
    // A second resolution (e.g. authHeader for a REST call) must NOT warn again.
    expect(mod.authHeader()).toEqual({ Authorization: 'Bearer s3cret' })
    expect(warn).toHaveBeenCalledTimes(1)
    const text = String(warn.mock.calls[0][0])
    expect(text).toContain('192.168.1.20')
    expect(text).toContain('PLAINTEXT')
    // Never the token.
    expect(text).not.toContain('s3cret')
    expect(logFrontendError).toHaveBeenCalledTimes(1)
  })

  it('reports the warning to the durable frontend log (host only, redacted)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.localStorage.setItem('termul.webAuthToken', 's3cret')
    stubLocation('http:', 'nas.lan')
    const mod = await import('./web-auth-token')
    mod.getWebAuthToken()
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'web-auth-token',
        message: expect.stringContaining('nas.lan')
      })
    )
    const payload = vi.mocked(logFrontendError).mock.calls[0][0]
    expect(payload.message).not.toContain('s3cret')
  })

  it('stays silent on plaintext LOOPBACK origins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.localStorage.setItem('termul.webAuthToken', 's3cret')
    stubLocation('http:', 'localhost')
    const mod = await import('./web-auth-token')
    expect(mod.getWebAuthToken()).toBe('s3cret')
    expect(warn).not.toHaveBeenCalled()
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('stays silent on TLS origins, even non-loopback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.localStorage.setItem('termul.webAuthToken', 's3cret')
    stubLocation('https:', 'nas.lan')
    const mod = await import('./web-auth-token')
    expect(mod.getWebAuthToken()).toBe('s3cret')
    expect(warn).not.toHaveBeenCalled()
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('stays silent when there is no token to protect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubLocation('http:', '192.168.1.20')
    const mod = await import('./web-auth-token')
    expect(mod.getWebAuthToken()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(logFrontendError).not.toHaveBeenCalled()
  })
})
