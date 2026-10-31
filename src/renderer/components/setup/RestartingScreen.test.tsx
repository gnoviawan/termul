/**
 * Tests for the gh-1105 restart handoff screen: the server re-execs on the
 * new bind, so the screen polls `http://<host>:<port>/health` with
 * `fetch(url, {mode:'no-cors'})` (any HTTP answer = alive) and navigates to
 * the new origin, appending `#token=` when the apply reply carried a web
 * auth token (the existing `#token=` landing convention).
 *
 * `window.location` is swapped wholesale per test (same seam
 * `web-auth-token.test.ts` uses) — jsdom can't navigate anyway.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RestartingScreen,
  restartHealthUrl,
  restartLandingUrl,
  restartTargetHost
} from './RestartingScreen'

const fetchMock = vi.fn()
const realLocation = Object.getOwnPropertyDescriptor(window, 'location')
const assignMock = vi.fn()

function stubLocation(origin: string, hostname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      origin,
      hostname,
      protocol: 'http:',
      pathname: '/',
      search: '',
      hash: '',
      assign: assignMock
    }
  })
}

describe('RestartingScreen', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    assignMock.mockReset()
    stubLocation('http://127.0.0.1:8080', '127.0.0.1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (realLocation) Object.defineProperty(window, 'location', realLocation)
  })

  it('polls the new /health until it answers, then navigates to the new origin', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('refused'))
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValue({ ok: true })
    render(<RestartingScreen host="127.0.0.1" port={9090} />)

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('http://127.0.0.1:9090/'), {
      timeout: 5000
    })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9090/health', { mode: 'no-cors' })
  })

  it('appends #token= to the landing URL when a web auth token was issued', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    render(<RestartingScreen host="127.0.0.1" port={9090} webAuthToken="tok-1" />)

    await waitFor(
      () => expect(assignMock).toHaveBeenCalledWith('http://127.0.0.1:9090/#token=tok-1'),
      { timeout: 5000 }
    )
  })

  it('polls the page hostname for a wildcard bind (0.0.0.0 is not browsable)', async () => {
    stubLocation('http://myserver.lan:8080', 'myserver.lan')
    fetchMock.mockResolvedValue({ ok: true })
    render(<RestartingScreen host="0.0.0.0" port={9090} webAuthToken="t1" />)

    await waitFor(
      () => expect(assignMock).toHaveBeenCalledWith('http://myserver.lan:9090/#token=t1'),
      { timeout: 5000 }
    )
    expect(fetchMock).toHaveBeenCalledWith('http://myserver.lan:9090/health', {
      mode: 'no-cors'
    })
  })

  it('offers the new address as a manual link when the server stays down', async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValue(new Error('still down'))
    render(<RestartingScreen host="127.0.0.1" port={9090} />)

    // 30s+ of failed probes reveals the fallback (polling continues too).
    // act() flushes the setSlow render queued from the fetch .catch microtask.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    const link = screen.getByRole('link', { name: 'open the new address' })
    expect(link).toHaveAttribute('href', 'http://127.0.0.1:9090/')
    expect(assignMock).not.toHaveBeenCalled()
  })
})

describe('restart helpers', () => {
  afterEach(() => {
    if (realLocation) Object.defineProperty(window, 'location', realLocation)
  })

  it('maps wildcard binds onto the page hostname', () => {
    stubLocation('http://nas.local:8080', 'nas.local')
    expect(restartTargetHost('0.0.0.0')).toBe('nas.local')
    expect(restartTargetHost('::')).toBe('nas.local')
    expect(restartTargetHost('127.0.0.1')).toBe('127.0.0.1')
  })

  it('builds the health and landing URLs', () => {
    expect(restartHealthUrl('127.0.0.1', 9090)).toBe('http://127.0.0.1:9090/health')
    expect(restartLandingUrl('127.0.0.1', 9090)).toBe('http://127.0.0.1:9090/')
    expect(restartLandingUrl('127.0.0.1', 9090, 'a b/c')).toBe(
      'http://127.0.0.1:9090/#token=a%20b%2Fc'
    )
  })
})
