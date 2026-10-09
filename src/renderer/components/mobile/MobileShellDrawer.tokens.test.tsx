import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mobile shell drawer token/copy contract (story 12 QA F7/F12, retargeted at the
// drawer-as-home revamp):
//   - drawer width min(82vw, 20rem); the old `max-w-20rem` cap class was
//     invalid Tailwind and capped nothing
//   - drawer header stays in the p-2 family (no px-4 py-3 drift)
//   - the unlabeled "Chats" scope label is replaced by real `Open` / `History`
//     section headings (the search now sits above both, scoped to History)
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

vi.mock('@/components/chat/ChatHistoryTab', () => ({
  ChatHistoryTab: () => <div data-testid="chat-history-stub" />
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

  it('drawer width is min(82vw, 20rem), with no invalid cap class', () => {
    const cls = renderDrawer().className

    // Today's `w-[72vw] max-w-20rem` had a cap class Tailwind never generated,
    // so no cap applied. The width token carries the cap itself.
    expect(cls).toContain('w-[min(82vw,20rem)]')
    expect(cls).not.toContain('max-w-20rem')
    expect(cls).not.toContain('w-[72vw]')
    expect(cls).not.toContain('100vw-3rem')
  })

  it('drawer header uses the p-2 family (no px-4 py-3 drift)', () => {
    const drawer = renderDrawer()

    // SheetHeader renders a plain div: the drawer's first bordered section.
    const headerDiv = drawer.querySelector('.border-b')
    expect(headerDiv).toBeTruthy()
    const cls = headerDiv?.className ?? ''
    expect(cls).toContain('p-2')
    expect(cls).not.toContain('px-4')
    expect(cls).not.toContain('px-3')
  })

  it('replaces the Chats scope label with Open and History headings, search above both', () => {
    const drawer = renderDrawer()

    const labels = Array.from(drawer.querySelectorAll('.label-group'))
    // QA F12: the old unlabeled "Chats" divider is gone.
    expect(labels.find((el) => el.textContent === 'Chats')).toBeUndefined()
    const open = labels.find((el) => el.textContent === 'Open')
    const history = labels.find((el) => el.textContent === 'History')
    expect(open?.tagName).toBe('H2')
    expect(history?.tagName).toBe('H2')

    const search = screen.getByRole('textbox', { name: 'Search chats' })
    const stub = drawer.querySelector('[data-testid="chat-history-stub"]')
    expect(stub).toBeTruthy()
    const follows = (a: Node | null | undefined, b: Node | null | undefined): boolean =>
      Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(search, open)).toBe(true)
    expect(follows(open, history)).toBe(true)
    // The History heading sits directly above the history body it labels.
    expect(follows(history, stub)).toBe(true)
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
