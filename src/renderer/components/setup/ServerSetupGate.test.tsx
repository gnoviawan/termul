/**
 * Tests for the gh-1105 setup gate: children render only once the
 * `/health` probe says the server is configured — `checking` shows a splash
 * (the app stack must never boot against a setup-mode server), `setup`
 * swaps in the full-screen wizard.
 *
 * `useWebSetupGate` (`@/lib/web-setup-gate`) and `webSetupApi`
 * (`@/lib/web-setup-api`) belong to a parallel slice — mocked here per the
 * settled contract.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api, gateRef } = vi.hoisted(() => ({
  api: { getStatus: vi.fn() },
  gateRef: { current: 'ok' as 'checking' | 'setup' | 'ok' }
}))

vi.mock('@/lib/web-setup-gate', () => ({ useWebSetupGate: () => gateRef.current }))
vi.mock('@/lib/web-setup-api', () => ({ webSetupApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { ServerSetupGate } from './ServerSetupGate'

const DEFAULT_ANSWERS = {
  host: '127.0.0.1',
  port: 8080,
  sessionsDir: '/state/termul/sessions',
  projectsFile: '/state/termul/projects.json',
  allowRemoteWrites: false,
  updateChannel: null,
  updateIntervalSecs: 21600
}

describe('ServerSetupGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gateRef.current = 'ok'
    api.getStatus.mockResolvedValue({
      success: true,
      data: { setupRequired: true, defaults: DEFAULT_ANSWERS }
    })
  })

  it('renders children when the gate is ok', () => {
    render(
      <ServerSetupGate>
        <p>the app</p>
      </ServerSetupGate>
    )
    expect(screen.getByText('the app')).toBeInTheDocument()
  })

  it('shows a loading splash while checking (children stay unmounted)', () => {
    gateRef.current = 'checking'
    render(
      <ServerSetupGate>
        <p>the app</p>
      </ServerSetupGate>
    )
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('the app')).not.toBeInTheDocument()
  })

  it('swaps children for the full-screen wizard when setup is required', async () => {
    gateRef.current = 'setup'
    render(
      <ServerSetupGate>
        <p>the app</p>
      </ServerSetupGate>
    )
    await waitFor(() => expect(screen.getByText('Set up Termul')).toBeInTheDocument())
    expect(screen.queryByText('the app')).not.toBeInTheDocument()
  })
})
