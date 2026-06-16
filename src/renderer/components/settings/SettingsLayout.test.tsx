import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsSearchEntry } from '@/lib/settings-search'
import { type SettingsCategory, SettingsLayout, SettingsSection } from './SettingsLayout'

// jsdom does not implement these; the layout uses them for navigation/scroll-spy.
window.HTMLElement.prototype.scrollIntoView = vi.fn()

class IntersectionObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn(() => [])
  root = null
  rootMargin = ''
  thresholds = []
  constructor(_cb: IntersectionObserverCallback) {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
  ;(window.HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear()
})

const categories: SettingsCategory[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'shell', label: 'Shell' },
  { id: 'updates', label: 'Updates' }
]

const searchIndex: SettingsSearchEntry[] = [
  { categoryId: 'appearance', label: 'Font Family', description: 'monospace font' },
  { categoryId: 'shell', label: 'Default Shell', keywords: ['bash'] },
  { categoryId: 'updates', label: 'Auto-update', description: 'check for updates' }
]

function renderLayout() {
  return render(
    <SettingsLayout categories={categories} searchIndex={searchIndex}>
      <SettingsSection id="appearance">
        <h2>Appearance</h2>
      </SettingsSection>
      <SettingsSection id="shell">
        <h2>Shell</h2>
      </SettingsSection>
      <SettingsSection id="updates">
        <h2>Updates</h2>
      </SettingsSection>
    </SettingsLayout>
  )
}

describe('SettingsLayout', () => {
  it('renders all categories in the sidebar', () => {
    renderLayout()
    const nav = screen.getByRole('navigation', { name: /settings categories/i })
    expect(nav).toBeInTheDocument()
    for (const category of categories) {
      expect(screen.getByRole('button', { name: category.label })).toBeInTheDocument()
    }
  })

  it('marks the first category active by default', () => {
    renderLayout()
    expect(screen.getByRole('button', { name: 'Appearance' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('scrolls to a section and activates it when a category is clicked', () => {
    renderLayout()
    const shellButton = screen.getByRole('button', { name: 'Shell' })
    fireEvent.click(shellButton)
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
    expect(shellButton).toHaveAttribute('aria-current', 'true')
  })

  it('renders the section content tagged with the category id', () => {
    const { container } = renderLayout()
    expect(container.querySelector('[data-settings-section="appearance"]')).toBeInTheDocument()
    expect(container.querySelector('#settings-section-shell')).toBeInTheDocument()
  })

  it('filters to matching settings when searching', () => {
    renderLayout()
    const search = screen.getByLabelText('Search settings')
    fireEvent.change(search, { target: { value: 'font' } })
    expect(screen.getByText('Font Family')).toBeInTheDocument()
    // Non-matching categories are not shown as plain category buttons while searching.
    expect(screen.queryByRole('button', { name: 'Updates' })).not.toBeInTheDocument()
  })

  it('matches a setting via keywords', () => {
    renderLayout()
    const search = screen.getByLabelText('Search settings')
    fireEvent.change(search, { target: { value: 'bash' } })
    expect(screen.getByText('Default Shell')).toBeInTheDocument()
  })

  it('shows an empty state when no settings match', () => {
    renderLayout()
    const search = screen.getByLabelText('Search settings')
    fireEvent.change(search, { target: { value: 'zzzzz' } })
    expect(screen.getByText(/no settings match/i)).toBeInTheDocument()
  })

  it('selecting a search result scrolls to its section', () => {
    renderLayout()
    const search = screen.getByLabelText('Search settings')
    fireEvent.change(search, { target: { value: 'font' } })
    fireEvent.click(screen.getByText('Font Family'))
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('clears the search when the clear button is pressed', () => {
    renderLayout()
    const search = screen.getByLabelText('Search settings') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'font' } })
    fireEvent.click(screen.getByLabelText('Clear search'))
    expect(search.value).toBe('')
    // Category buttons return after clearing.
    expect(screen.getByRole('button', { name: 'Updates' })).toBeInTheDocument()
  })
})
