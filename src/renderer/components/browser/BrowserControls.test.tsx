import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { BrowserControls } from './BrowserControls'

// Mock browser-api
vi.mock('@/lib/browser-api', () => ({
  browserTabGoBack: vi.fn().mockResolvedValue({ success: true }),
  browserTabGoForward: vi.fn().mockResolvedValue({ success: true }),
  browserTabReload: vi.fn().mockResolvedValue({ success: true }),
  browserTabOpenDevtools: vi.fn().mockResolvedValue({ success: true }),
  browserTabInjectAgentation: vi.fn().mockResolvedValue({ success: true })
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>
}

function renderWithProvider(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

describe('BrowserControls', () => {
  beforeEach(() => {
    useBrowserSessionStore.setState({ tabs: new Map() })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when tab has no URL', () => {
    useBrowserSessionStore.getState().createTab('tab-1', '')
    const { container } = renderWithProvider(<BrowserControls browserTabId="tab-1" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders agentation toolbar button', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)
    expect(screen.getByLabelText('Inject agentation toolbar')).toBeTruthy()
  })

  it('calls browserTabInjectAgentation on PenTool button click', async () => {
    const { browserTabInjectAgentation } = await import('@/lib/browser-api')
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const btn = screen.getByLabelText('Inject agentation toolbar')
    fireEvent.click(btn)

    expect(browserTabInjectAgentation).toHaveBeenCalledWith('tab-1')
  })

  it('renders browser navigation and debug button', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    expect(screen.getByTitle('Back')).toBeTruthy()
    expect(screen.getByTitle('Forward')).toBeTruthy()
    expect(screen.getByTitle('Reload')).toBeTruthy()
  })

  // P12: the Debug Console button is hidden in production builds.
  it('hides the Debug Console button when import.meta.env.PROD is true', () => {
    vi.stubEnv('PROD', true)
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)
    expect(screen.queryByLabelText('Open debug console')).toBeNull()
    vi.unstubAllEnvs()
  })

  it('renders URL input with current tab URL', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com/page')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const input = screen.getByPlaceholderText('Enter URL...')
    expect((input as HTMLInputElement).value).toBe('https://example.com/page')
  })

  it('shows loading spinner when tab is loading', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    useBrowserSessionStore.getState().setLoading('tab-1', true)
    const { container } = renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })
})
