import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BrowserControls } from './BrowserControls'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

// Mock browser-api
vi.mock('@/lib/browser-api', () => ({
  browserTabGoBack: vi.fn().mockResolvedValue({ success: true }),
  browserTabGoForward: vi.fn().mockResolvedValue({ success: true }),
  browserTabReload: vi.fn().mockResolvedValue({ success: true }),
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

  it('renders nothing when tab has no URL', () => {
    useBrowserSessionStore.getState().createTab('tab-1', '')
    useBrowserSessionStore.setState((state) => {
      const next = new Map(state.tabs)
      const tab = next.get('tab-1')
      if (tab) {
        next.set('tab-1', { ...tab, url: '' })
      }
      return { tabs: next }
    })

    const { container } = renderWithProvider(<BrowserControls browserTabId="tab-1" />)
    expect(container.innerHTML).toBe('')
  })

  it('renders annotation toggle button', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const toggleBtn = screen.getByLabelText('Enable annotation mode')
    expect(toggleBtn).toBeInTheDocument()
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows active state when annotation mode is enabled', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    useBrowserSessionStore.getState().setAnnotationMode('tab-1', true)

    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const toggleBtn = screen.getByLabelText('Disable annotation mode')
    expect(toggleBtn).toBeInTheDocument()
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('toggles annotation mode on button click', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')

    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const toggleBtn = screen.getByLabelText('Enable annotation mode')
    fireEvent.click(toggleBtn)

    const tab = useBrowserSessionStore.getState().tabs.get('tab-1')
    expect(tab?.annotationMode).toBe(true)
  })

  it('toggles annotation mode off when already active', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    useBrowserSessionStore.getState().setAnnotationMode('tab-1', true)

    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const toggleBtn = screen.getByLabelText('Disable annotation mode')
    fireEvent.click(toggleBtn)

    const tab = useBrowserSessionStore.getState().tabs.get('tab-1')
    expect(tab?.annotationMode).toBe(false)
  })

  it('has active visual styling when annotation mode is on', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    useBrowserSessionStore.getState().setAnnotationMode('tab-1', true)

    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const toggleBtn = screen.getByLabelText('Disable annotation mode')
    // Active state should have ring and shadow classes
    expect(toggleBtn.className).toContain('ring-2')
    expect(toggleBtn.className).toContain('ring-primary/30')
  })

  it('renders browser navigation buttons', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    expect(screen.getByTitle('Back')).toBeInTheDocument()
    expect(screen.getByTitle('Forward')).toBeInTheDocument()
    expect(screen.getByTitle('Reload')).toBeInTheDocument()
  })

  it('renders URL input with current tab URL', () => {
    useBrowserSessionStore
      .getState()
      .createTab('tab-1', 'https://example.com/page')

    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    const input = screen.getByPlaceholderText('Enter URL...') as HTMLInputElement
    expect(input.value).toBe('https://example.com/page')
  })

  it('shows loading spinner when tab is loading', () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    useBrowserSessionStore.setState((state) => {
      const next = new Map(state.tabs)
      const tab = next.get('tab-1')
      if (tab) {
        next.set('tab-1', { ...tab, loading: true })
      }
      return { tabs: next }
    })

    renderWithProvider(<BrowserControls browserTabId="tab-1" />)

    // The Loader2 icon should have animate-spin class
    const loader = document.querySelector('.animate-spin')
    expect(loader).toBeTruthy()
  })
})
