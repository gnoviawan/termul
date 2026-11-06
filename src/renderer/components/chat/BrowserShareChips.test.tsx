import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserShareView } from '@/lib/test-utils/browser-share'

const { revoke, runtime } = vi.hoisted(() => ({
  revoke: vi.fn(),
  runtime: { tauri: true }
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => runtime.tauri }))
vi.mock('@/lib/browser-share-api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/browser-share-api')>()),
  browserShareRevoke: (id: string) => revoke(id),
  browserShareList: async () => ({ success: true, data: [] }),
  onBrowserShareChanged: () => () => {}
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

import { useBrowserShareStore } from '@/stores/browser-share-store'
import { BrowserShareChips } from './BrowserShareChips'

const store = () => useBrowserShareStore.getState()

beforeEach(() => {
  revoke.mockReset()
  runtime.tauri = true
  useBrowserShareStore.setState({
    shares: {},
    pending: {},
    ended: {},
    revoking: {},
    consentTabId: null
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BrowserShareChips', () => {
  it('shows origin, scopes, state and time left, scoped to this session', () => {
    store().upsert(browserShareView({ scopes: ['content', 'screenshot'] }), { pending: true })
    store().upsert(browserShareView({ shareId: 'other', sessionId: 'sess-2' }))
    render(<BrowserShareChips sessionId="sess-1" />)
    const chips = screen.getAllByRole('listitem')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent('https://app.example.com')
    expect(chips[0]).toHaveTextContent('Page content · Screenshot · Ready to share · 10 min left')
  })

  it('stops a live share in one action', async () => {
    revoke.mockResolvedValue({ success: true, data: undefined })
    store().upsert(browserShareView())
    render(<BrowserShareChips sessionId="sess-1" />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Stop sharing https://app.example.com' }))
    )
    expect(revoke).toHaveBeenCalledWith('host-share-1')
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('keeps the chip and says so when stop fails', async () => {
    revoke.mockResolvedValue({ success: false, code: 'FAILED' })
    store().upsert(browserShareView())
    render(<BrowserShareChips sessionId="sess-1" />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Stop sharing/ })))
    expect(screen.getByRole('listitem')).toHaveTextContent('Could not stop. Try again.')
  })

  it('shows why a pending share ended and dismisses it locally', async () => {
    store().upsert(browserShareView(), { pending: true })
    store().upsert(browserShareView({ status: 'navigated' }))
    render(<BrowserShareChips sessionId="sess-1" />)
    const chip = screen.getByRole('listitem')
    expect(chip).toHaveAttribute('data-browser-share-chip', 'ended')
    expect(chip).toHaveTextContent('Not sent · Page changed, share again')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss https://app.example.com' }))
    )
    expect(revoke).not.toHaveBeenCalled()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('flips to expired at the expiry time without a host event', () => {
    vi.useFakeTimers()
    store().upsert(browserShareView({ expiresAtMs: Date.now() + 30_000 }), { pending: true })
    render(<BrowserShareChips sessionId="sess-1" />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Less than 1 min left')
    act(() => {
      vi.advanceTimersByTime(31_000)
    })
    expect(screen.getByRole('listitem')).toHaveAttribute('data-browser-share-chip', 'ended')
    expect(screen.getByRole('listitem')).toHaveTextContent('Not sent · Expired')
  })

  it('renders nothing outside the desktop app', () => {
    runtime.tauri = false
    store().upsert(browserShareView())
    const { container } = render(<BrowserShareChips sessionId="sess-1" />)
    expect(container).toBeEmptyDOMElement()
  })
})
