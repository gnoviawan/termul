import { act, fireEvent, render, screen } from '@testing-library/react'
import { type ComponentProps, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileShellHeader } from './MobileShellHeader'

const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: false as boolean } }))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

const NARROW_QUERY = '(max-width: 360px)'
const originalMatchMedia = window.matchMedia

/** Stubs matchMedia: only the ≤360px query matches `narrow`; returns a way to flip it live. */
function stubNarrowViewport(narrow: boolean): { setNarrow: (next: boolean) => void } {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const narrowMql = {
    matches: narrow,
    media: NARROW_QUERY,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener)
    },
    dispatchEvent: () => false
  }
  window.matchMedia = ((query: string) =>
    query === NARROW_QUERY
      ? narrowMql
      : { ...narrowMql, matches: false, media: query }) as unknown as typeof window.matchMedia
  return {
    setNarrow: (next) => {
      narrowMql.matches = next
      act(() => {
        for (const listener of listeners) listener({ matches: next })
      })
    }
  }
}

type HeaderProps = ComponentProps<typeof MobileShellHeader>

function renderHeader(overrides: Partial<HeaderProps> = {}) {
  const refs = {
    more: createRef<HTMLButtonElement>(),
    subtitle: createRef<HTMLButtonElement>(),
    title: createRef<HTMLHeadingElement>()
  }
  const props: HeaderProps = {
    title: 'Fix auth redirect loop',
    subtitleText: 'termul · main · Local',
    subtitleLabel: 'termul · main, switch project',
    drawerOpen: false,
    onOpenDrawer: vi.fn(),
    projectSheetOpen: false,
    onOpenProjectSheet: vi.fn(),
    attentionCount: 0,
    isTerminal: false,
    canNewChat: true,
    onNewChat: vi.fn(),
    onNewTerminal: vi.fn(),
    moreOpen: false,
    onOpenMore: vi.fn(),
    moreButtonRef: refs.more,
    subtitleRef: refs.subtitle,
    titleRef: refs.title,
    ...overrides
  }
  const view = render(<MobileShellHeader {...props} />)
  return { ...view, props, refs }
}

describe('MobileShellHeader', () => {
  beforeEach(() => {
    tauriRef.current = false
    stubNarrowViewport(false)
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  describe('layout', () => {
    it('is a min-h-14 row of three 44px icon slots with no sideways scroller', () => {
      const { container } = renderHeader()

      const header = container.querySelector('header')
      expect(header?.className).toContain('min-h-14')
      expect(header?.className).not.toMatch(/(^|\s)h-14(\s|$)/)
      expect(header?.querySelector('.overflow-x-auto')).toBeNull()

      for (const name of ['Open menu', 'New chat', 'More']) {
        const button = screen.getByRole('button', { name })
        expect(button.className, name).toContain('size-11')
        expect(button.className, name).not.toContain('size-10')
      }
      // ☰, subtitle, ✎ and ⋯: no pill at a zero count, nothing else.
      expect(screen.getAllByRole('button')).toHaveLength(4)
    })

    it('renders the title as a plain heading over the subtitle button', () => {
      const { container, refs } = renderHeader()

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toHaveTextContent('Fix auth redirect loop')
      expect(heading.id).toBe('mobile-shell-title')
      expect(heading).toHaveAttribute('tabindex', '-1')
      expect(heading.className).toContain('pointer-events-none')
      expect(heading.className).toContain('truncate')
      expect(refs.title.current).toBe(heading)

      const block = container.querySelector('[data-mobile-header-title]')
      expect(block).not.toBeNull()
      for (const cls of ['relative', 'flex', 'min-w-0', 'flex-1', 'flex-col', 'self-stretch']) {
        expect(block?.className, cls).toContain(cls)
      }
      expect(block?.contains(heading)).toBe(true)
      expect(block?.contains(refs.subtitle.current)).toBe(true)
      expect(heading.compareDocumentPosition(refs.subtitle.current as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    })

    it('has no button for the controls that moved into the ⋯ sheets', () => {
      renderHeader()

      for (const name of [
        'Switch project',
        'Browse files',
        'Command palette',
        'New project',
        'Git changes',
        'Restart terminal',
        'Close terminal'
      ]) {
        expect(screen.queryByRole('button', { name }), name).not.toBeInTheDocument()
      }
    })
  })

  describe('☰ menu', () => {
    it('opens the drawer and reflects it with aria-expanded and aria-controls', () => {
      const onOpenDrawer = vi.fn()
      const { rerender, props } = renderHeader({ onOpenDrawer })

      const menu = screen.getByRole('button', { name: 'Open menu' })
      expect(menu).toHaveAttribute('aria-expanded', 'false')
      // A closed control never references a missing id.
      expect(menu).not.toHaveAttribute('aria-controls')

      fireEvent.click(menu)
      expect(onOpenDrawer).toHaveBeenCalledTimes(1)

      rerender(<MobileShellHeader {...props} drawerOpen />)
      expect(menu).toHaveAttribute('aria-expanded', 'true')
      expect(menu).toHaveAttribute('aria-controls', 'mobile-shell-drawer')
    })
  })

  describe('subtitle button', () => {
    it('shows the subtitle text, a chevron and the "{project} · {branch}, switch project" name', () => {
      renderHeader()

      const subtitle = screen.getByRole('button', { name: 'termul · main, switch project' })
      expect(subtitle).toHaveTextContent('termul · main · Local')
      expect(subtitle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(subtitle).toHaveAttribute('aria-haspopup', 'dialog')
      expect(subtitle).toHaveAttribute('aria-expanded', 'false')
      expect(subtitle).not.toHaveAttribute('aria-controls')
      // The ::after layer stretches the hit area to the full title block.
      expect(subtitle.className).toContain("after:absolute after:inset-0 after:content-['']")
      expect(subtitle.className).toContain('text-muted-foreground')
    })

    it('opens the project sheet and points aria-controls at it while open', () => {
      const onOpenProjectSheet = vi.fn()
      const { rerender, props } = renderHeader({ onOpenProjectSheet })

      const subtitle = screen.getByRole('button', { name: 'termul · main, switch project' })
      fireEvent.click(subtitle)
      expect(onOpenProjectSheet).toHaveBeenCalledTimes(1)

      rerender(<MobileShellHeader {...props} projectSheetOpen />)
      expect(subtitle).toHaveAttribute('aria-expanded', 'true')
      expect(subtitle).toHaveAttribute('aria-controls', 'mobile-project-sheet')
    })

    it('is plain text in the Tauri context', () => {
      tauriRef.current = true
      renderHeader()

      expect(screen.getByText('termul · main · Local')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'termul · main, switch project' })
      ).not.toBeInTheDocument()
    })

    it('renders the no-project and non-git subtitles it is given', () => {
      renderHeader({ subtitleText: 'No project', subtitleLabel: 'No project, switch project' })

      expect(screen.getByRole('button', { name: 'No project, switch project' })).toHaveTextContent(
        'No project'
      )
    })
  })

  describe('attention pill', () => {
    it('is not rendered at a zero count', () => {
      renderHeader({ attentionCount: 0 })

      expect(screen.queryByRole('button', { name: /needs? you/ })).not.toBeInTheDocument()
    })

    it('shows ● N for the other chats that need you and opens the drawer', () => {
      const onOpenDrawer = vi.fn()
      renderHeader({ attentionCount: 2, onOpenDrawer })

      const pill = screen.getByRole('button', { name: '2 other chats need you' })
      expect(pill).toHaveTextContent('2')
      expect(pill.className).toContain('bg-warning/20')
      expect(pill.className).toContain('text-warning')
      expect(pill.className).toContain('tabular-nums')
      expect(pill.className).toContain("after:absolute after:-inset-2 after:content-['']")
      const dot = pill.querySelector('span[aria-hidden="true"]')
      expect(dot?.className).toContain('size-2')
      expect(dot?.className).toContain('bg-warning')

      fireEvent.click(pill)
      expect(onOpenDrawer).toHaveBeenCalledTimes(1)
    })

    it('uses the singular name for one chat', () => {
      renderHeader({ attentionCount: 1 })

      expect(screen.getByRole('button', { name: '1 other chat needs you' })).toBeInTheDocument()
    })

    it('caps the visible count at 9+ and keeps the exact count in the name', () => {
      renderHeader({ attentionCount: 12 })

      const pill = screen.getByRole('button', { name: '12 other chats need you' })
      expect(pill).toHaveTextContent('9+')
    })

    it('reports aria-expanded and aria-controls like the menu, with no live region', () => {
      const { container } = renderHeader({ attentionCount: 2, drawerOpen: true })

      const pill = screen.getByRole('button', { name: '2 other chats need you' })
      expect(pill).toHaveAttribute('aria-expanded', 'true')
      expect(pill).toHaveAttribute('aria-controls', 'mobile-shell-drawer')
      expect(container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull()
    })
  })

  describe('narrow viewport (≤360px)', () => {
    it('folds the pill into a dot on the menu button and names the count', () => {
      stubNarrowViewport(true)
      renderHeader({ attentionCount: 2 })

      expect(screen.queryByRole('button', { name: /other chats? needs? you/ })).toBeNull()
      const menu = screen.getByRole('button', { name: 'Open menu, 2 chats need you' })
      const dot = menu.querySelector('span[aria-hidden="true"]')
      expect(dot).not.toBeNull()
      expect(dot?.className).toContain('size-2')
      expect(dot?.className).toContain('rounded-full')
      expect(dot?.className).toContain('bg-warning')
      expect(menu.className).toContain('relative')
    })

    it('uses the singular menu name for one chat', () => {
      stubNarrowViewport(true)
      renderHeader({ attentionCount: 1 })

      expect(
        screen.getByRole('button', { name: 'Open menu, 1 chat needs you' })
      ).toBeInTheDocument()
    })

    it('keeps the plain menu name and no dot at a zero count', () => {
      stubNarrowViewport(true)
      renderHeader({ attentionCount: 0 })

      const menu = screen.getByRole('button', { name: 'Open menu' })
      expect(menu.querySelector('span[aria-hidden="true"]')).toBeNull()
    })

    it('follows the viewport live between the pill and the dot', () => {
      const viewport = stubNarrowViewport(false)
      renderHeader({ attentionCount: 3 })
      expect(screen.getByRole('button', { name: '3 other chats need you' })).toBeInTheDocument()

      viewport.setNarrow(true)
      expect(screen.queryByRole('button', { name: '3 other chats need you' })).toBeNull()
      expect(
        screen.getByRole('button', { name: 'Open menu, 3 chats need you' })
      ).toBeInTheDocument()

      viewport.setNarrow(false)
      expect(screen.getByRole('button', { name: '3 other chats need you' })).toBeInTheDocument()
    })
  })

  describe('✎ new slot', () => {
    it('calls onNewChat in a chat or tab context', () => {
      const onNewChat = vi.fn()
      renderHeader({ onNewChat })

      fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
      expect(onNewChat).toHaveBeenCalledTimes(1)
    })

    it('is not rendered, not disabled, when a chat cannot be started', () => {
      renderHeader({ canNewChat: false })

      expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
    })

    it('becomes New terminal in a terminal context', () => {
      const onNewTerminal = vi.fn()
      const onNewChat = vi.fn()
      renderHeader({ isTerminal: true, onNewTerminal, onNewChat })

      expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
      const button = screen.getByRole('button', { name: 'New terminal' })
      expect(button.className).toContain('size-11')
      fireEvent.click(button)
      expect(onNewTerminal).toHaveBeenCalledTimes(1)
      expect(onNewChat).not.toHaveBeenCalled()
    })

    it('is omitted in a terminal context without a new-terminal handler', () => {
      renderHeader({ isTerminal: true, onNewTerminal: undefined })

      expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument()
    })
  })

  describe('⋯ more slot', () => {
    it('is "More" in a chat context and reports the header sheet while open', () => {
      const onOpenMore = vi.fn()
      const { rerender, props, refs } = renderHeader({ onOpenMore })

      const more = screen.getByRole('button', { name: 'More' })
      expect(more).toHaveAttribute('aria-haspopup', 'dialog')
      expect(more).toHaveAttribute('aria-expanded', 'false')
      expect(more).not.toHaveAttribute('aria-controls')
      expect(refs.more.current).toBe(more)

      fireEvent.click(more)
      expect(onOpenMore).toHaveBeenCalledTimes(1)

      rerender(<MobileShellHeader {...props} moreOpen />)
      expect(more).toHaveAttribute('aria-expanded', 'true')
      expect(more).toHaveAttribute('aria-controls', 'mobile-header-more-sheet')
    })

    it('is "Terminal actions" in a terminal context and reports the terminal sheet while open', () => {
      renderHeader({ isTerminal: true, moreOpen: true })

      const more = screen.getByRole('button', { name: 'Terminal actions' })
      expect(more).toHaveAttribute('aria-haspopup', 'dialog')
      expect(more).toHaveAttribute('aria-expanded', 'true')
      expect(more).toHaveAttribute('aria-controls', 'mobile-terminal-actions-sheet')
    })
  })
})
