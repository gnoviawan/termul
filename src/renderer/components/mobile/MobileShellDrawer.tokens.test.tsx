import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mobile shell drawer token/copy contract (story 12 QA F7/F12, retargeted at the
// drawer-as-home revamp):
//   - full-screen drawer: full width, safe-area padded
//   - Claude-style borderless header: the Termul wordmark
//   - one muted "Recents" heading over the merged chat list (open chats and
//     history together), below the search
//   - semantic tokens and size tokens only inside the drawer

const { tauriRef, workspaceRef } = vi.hoisted(() => ({
  tauriRef: { current: false as boolean },
  workspaceRef: {
    current: {
      leaves: [] as unknown[],
      activePaneId: 'pane-1',
      removeTab: vi.fn(),
      setActiveTab: vi.fn()
    }
  }
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'test' })
  }
})

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        root: { leaves: workspaceRef.current.leaves },
        activePaneId: workspaceRef.current.activePaneId,
        removeTab: workspaceRef.current.removeTab,
        setActiveTab: workspaceRef.current.setActiveTab
      })
    ),
    { getState: () => workspaceRef.current }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ terminals: [] })),
    { getState: () => ({ terminals: [] }) }
  )
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ openFiles: new Map() })),
    { getState: () => ({ openFiles: new Map() }) }
  )
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: (selector: (s: unknown) => unknown) => selector({ tabs: new Map() })
}))

import { useAcpStore } from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useProjectStore } from '@/stores/project-store'
import { MobileShellDrawer } from './MobileShellDrawer'

function renderDrawer(): HTMLElement {
  render(
    <MobileShellDrawer
      open
      onOpenChange={vi.fn()}
      activeTabId="tab-1"
      activeSessionId="s1"
      canNewChat
      onNewChat={vi.fn()}
      onNewTerminal={vi.fn()}
      onOpenGitHistory={vi.fn()}
      onOpenProjects={vi.fn()}
    />
  )
  const drawer = document.getElementById('mobile-shell-drawer')
  if (!drawer) throw new Error('drawer not rendered')
  return drawer
}

describe('MobileShellDrawer token sweep', () => {
  beforeEach(() => {
    tauriRef.current = false
    useAcpStore.setState(FRESH)
    seedOptionsSession('s1', 'agent-1', { title: 'Hello chat' })
    useProjectStore.setState({
      projects: [
        { id: 'p1', name: 'Demo', color: 'blue', path: '/demo', gitBranch: 'main', isGitRepo: true }
      ],
      activeProjectId: 'p1'
    })
    workspaceRef.current = {
      ...workspaceRef.current,
      leaves: [
        {
          type: 'leaf',
          id: 'pane-1',
          tabs: [{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }],
          activeTabId: 'tab-1'
        }
      ],
      activePaneId: 'pane-1'
    }
  })

  it('drawer is full-screen: full width, no width cap, safe-area padded at the top', () => {
    const cls = renderDrawer().className

    expect(cls).toContain('w-full')
    expect(cls).toContain('max-w-none')
    expect(cls).toContain('sm:max-w-none')
    expect(cls).toContain('pt-[env(safe-area-inset-top)]')
    // The built-in close moves below the top inset with the content.
    expect(cls).toContain('[&>button:last-child]:mt-[env(safe-area-inset-top)]')
    expect(cls).not.toContain('w-[min(82vw,20rem)]')
    expect(cls).not.toContain('max-w-20rem')
  })

  it('drawer top row is the borderless project row, the title only naming the dialog', () => {
    const drawer = renderDrawer()

    const title = screen.getByRole('heading', { level: 2, name: 'Termul' })
    expect(title).toHaveClass('sr-only')
    expect(title.parentElement).toContainElement(screen.getByRole('button', { name: /Demo/ }))
    // The header, the section tabs and the search sit on the sheet without rules.
    expect(drawer.querySelector('.border-b')).toBeNull()
  })

  it('shows one Recents heading below the search, above the merged chat list', () => {
    const drawer = renderDrawer()

    const headings = Array.from(drawer.querySelectorAll('h2')).map((el) => el.textContent)
    expect(headings).toEqual(['Termul', 'Recents'])
    const search = screen.getByRole('textbox', { name: 'Search chats' })
    const recents = screen.getByRole('heading', { level: 2, name: 'Recents' })
    expect(recents).toHaveClass('text-muted-foreground')
    const row = screen.getByRole('button', { name: 'Hello chat' })
    const follows = (a: Node | null | undefined, b: Node | null | undefined): boolean =>
      Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(search, recents)).toBe(true)
    expect(follows(recents, row)).toBe(true)
    expect(row).toHaveClass('rounded-full', 'bg-secondary', 'text-base')
  })

  it('uses size tokens and semantic colours only (no text-[Npx], no palette primitives)', () => {
    const html = renderDrawer().innerHTML

    expect(html).not.toMatch(/text-\[\d+px\]/)
    expect(html).not.toMatch(
      /\b(?:bg|text|border|ring|fill|stroke)-(?:black|white|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d+)?\b/
    )
    // The status labels and connection text come from the token scale.
    expect(html).toContain('text-2xs')
  })
})
