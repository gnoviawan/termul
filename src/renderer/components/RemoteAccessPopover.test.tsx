import type { RemoteStatus } from '@shared/types/ipc.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RemoteAccessPopover } from './RemoteAccessPopover'

// QR mock: expose the encoded value so tests assert the URL the QR would draw,
// without depending on qrcode.react's SVG internals under jsdom.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />
}))

// Remote status store: `useRemoteStatus` is configurable per test; `getState`
// is used only on the toggle-success path.
const setStatus = vi.fn()
vi.mock('@/stores/remote-status-store', () => ({
  useRemoteStatus: vi.fn((): RemoteStatus | null => null),
  useRemoteStatusStore: { getState: () => ({ setStatus }) }
}))

const startMock = vi.fn()
const stopMock = vi.fn()
vi.mock('@/lib/api', () => ({
  remoteServerApi: {
    start: (...args: unknown[]) => startMock(...args),
    stop: () => stopMock(),
    status: vi.fn()
  },
  syncProjects: vi.fn(() => Promise.resolve({ success: true, data: undefined }))
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ projects: [], activeProjectId: null })
  }
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: {
    getState: () => ({
      loadSessionIndex: vi.fn(async () => {}),
      sessionIndex: [],
      messages: {}
    })
  }
}))

vi.mock('@/hooks/use-projects-persistence', () => ({
  toProjectSummaries: vi.fn(() => [])
}))

vi.mock('@/lib/acp-history-persistence', () => ({
  toPersistedSessionSummaries: vi.fn(() => [])
}))

// Silence sonner toasts in test output.
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { syncProjects } from '@/lib/api'
import { useRemoteStatus } from '@/stores/remote-status-store'

const RUNNING: RemoteStatus = {
  running: true,
  url: 'http://127.0.0.1:5123',
  port: 5123,
  bindMode: 'localhost',
  bindHost: '127.0.0.1',
  tunnelUrl: 'https://foo-bar.trycloudflare.com'
}

function renderPopover(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <RemoteAccessPopover />
    </TooltipProvider>
  )
}

/** Click the StatusBar trigger to open the Radix popover, then wait for the
 * toggle switch to mount (the content is portalled into document.body). */
async function openPopover(): Promise<HTMLElement> {
  const trigger = screen.getByLabelText('Remote terminal access')
  await fireEvent.click(trigger)
  return screen.findByRole('switch')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useRemoteStatus).mockReturnValue(null)
})

afterEach(() => {
  vi.mocked(useRemoteStatus).mockReturnValue(null)
})

describe('RemoteAccessPopover', () => {
  it('shows the globe trigger with the toggle off when no status', () => {
    renderPopover()
    const trigger = screen.getByLabelText('Remote terminal access')
    expect(trigger.getAttribute('aria-pressed')).toBe('false')
    // Popover is closed → no QR / copy-link in the DOM yet.
    expect(screen.queryByTestId('qr')).toBeNull()
    expect(screen.queryByText('Copy link')).toBeNull()
  })

  it('renders a QR from tunnelUrl when running (no bind selector, no URL row)', async () => {
    vi.mocked(useRemoteStatus).mockReturnValue(RUNNING)
    renderPopover()
    await openPopover()

    const qr = screen.getByTestId('qr')
    expect(qr.getAttribute('data-value')).toBe(RUNNING.tunnelUrl)
    // The simplify goal: no bind selector, no open-in-browser text row.
    expect(screen.queryByText('Listen on')).toBeNull()
    expect(screen.queryByText('Open in browser')).toBeNull()
    expect(screen.getByText('Copy link')).toBeDefined()
  })

  it('shows an inline error when start fails (no QR)', async () => {
    startMock.mockResolvedValueOnce({ success: false, error: 'tunnel down' })
    renderPopover()

    const toggle = await openPopover()
    await fireEvent.click(toggle)

    expect(await screen.findByText('tunnel down')).toBeDefined()
    expect(screen.queryByTestId('qr')).toBeNull()
  })

  it('starts remote access with no bind-mode arg on toggle on and seeds the web client', async () => {
    startMock.mockResolvedValueOnce({ success: true, data: RUNNING })
    renderPopover()

    const toggle = await openPopover()
    await fireEvent.click(toggle)

    // start() is called with no bindMode — the tunnel forces localhost.
    await waitFor(() => {
      expect(startMock).toHaveBeenCalledTimes(1)
    })
    expect(startMock).toHaveBeenCalledWith()
    expect(setStatus).toHaveBeenCalledWith(RUNNING)
    // Project metadata is seeded; chat history is read directly from the
    // durable Rust provider by the desktop-hosted browser.
    await waitFor(() => {
      expect(syncProjects).toHaveBeenCalledTimes(1)
    })
  })
})
