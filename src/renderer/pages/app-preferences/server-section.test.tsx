/**
 * Tests for the web-only Server preferences page (gh-1105).
 *
 * The page is hidden on the desktop runtime (mirror of UpdatesSection's
 * web filter). On web it loads `webSetupApi.getServerConfig()` and hosts the
 * setup wizard in reconfigure mode. `webSetupApi` is owned by a parallel
 * slice — mocked per the settled contract.
 */

import type { ServerSetupAnswers } from '@shared/types/server-setup.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api, tauriRef } = vi.hoisted(() => ({
  api: { getServerConfig: vi.fn(), validate: vi.fn(), applyServerConfig: vi.fn() },
  tauriRef: { current: false }
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => tauriRef.current }))
vi.mock('@/lib/web-setup-api', () => ({ webSetupApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { ServerSection } from './server-section'

const CONFIG: ServerSetupAnswers = {
  host: '0.0.0.0',
  port: 8080,
  sessionsDir: '/state/termul/sessions',
  projectsFile: '/state/termul/projects.json',
  allowRemoteWrites: true,
  updateChannel: 'stable',
  updateIntervalSecs: 21600
}

describe('ServerSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriRef.current = false
    api.getServerConfig.mockResolvedValue({ success: true, data: { config: CONFIG } })
    api.validate.mockResolvedValue({ success: true, data: { ok: true, fieldErrors: {} } })
    api.applyServerConfig.mockResolvedValue({
      success: true,
      data: { ok: true, host: '0.0.0.0', port: 8080 }
    })
  })

  it('renders nothing on the desktop runtime', () => {
    tauriRef.current = true
    const { container } = render(<ServerSection />)
    expect(container).toBeEmptyDOMElement()
    expect(api.getServerConfig).not.toHaveBeenCalled()
  })

  it('loads the current config and hosts the reconfigure wizard', async () => {
    render(<ServerSection />)

    await waitFor(() =>
      expect(screen.getByRole('form', { name: 'Server settings' })).toBeInTheDocument()
    )
    expect(api.getServerConfig).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Port')).toHaveValue(8080)
    // The public-bind config surfaces the remote-writes question.
    expect(screen.getByRole('switch', { name: 'Let other devices make changes' })).toBeChecked()
  })

  it('warns that saving restarts the server', async () => {
    render(<ServerSection />)

    await waitFor(() => expect(screen.getByText(/restarts the server/)).toBeInTheDocument())
  })

  it('shows a retryable error when the config cannot be loaded', async () => {
    api.getServerConfig
      .mockReset()
      .mockResolvedValueOnce({ success: false, error: 'nope', code: 'HTTP 404' })
      .mockResolvedValueOnce({ success: true, data: { config: CONFIG } })
    render(<ServerSection />)

    await waitFor(() =>
      expect(screen.getByText('Could not load the server settings.')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(screen.getByRole('form', { name: 'Server settings' })).toBeInTheDocument()
    )
    expect(api.getServerConfig).toHaveBeenCalledTimes(2)
  })
})
