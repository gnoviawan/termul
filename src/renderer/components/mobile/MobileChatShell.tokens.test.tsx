import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Story 12 (QA F7/F12): mobile shell drawer token/copy contract —
//   - drawer width ~70-75% viewport (w-[72vw] capped at 20rem; the old
//     w-[min(100vw-3rem,20rem)] read as 82% = page-jump)
//   - drawer header normalized to the p-2 family (no px-4 py-3 drift)
//   - the chat search sits under an explicit "Chats" section label (scope)

const { tauriRef, projectRef, workspaceRef, editorRef, browserTabsRef } = vi.hoisted(() => ({
  tauriRef: { current: false as boolean },
  projectRef: { current: null as { id: string; name: string; path?: string } | null },
  workspaceRef: {
    current: {
      leaves: [] as unknown[],
      activePaneId: 'pane-1',
      removeTab: vi.fn(),
      setActiveTab: vi.fn()
    }
  },
  editorRef: { current: { openFiles: new Map() } },
  browserTabsRef: { current: new Map() }
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => projectRef.current
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
    {
      getState: () => ({ terminals: [] })
    }
  )
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel(editorRef.current)),
    { getState: () => editorRef.current }
  )
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ tabs: browserTabsRef.current })
}))

vi.mock('@/stores/overlay-stack-store', () => ({
  useOverlayRegistration: () => undefined
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (s: unknown) => unknown) => selector({ sessions: {}, sessionIndex: [] })
}))

vi.mock('@/components/chat/ChatHistoryTab', () => ({
  ChatHistoryTab: () => <div data-testid="chat-history-stub" />
}))

vi.mock('@/components/chat/ProjectSwitcherDrawer', () => ({
  ProjectSwitcherDrawer: () => null
}))

vi.mock('@/components/mobile/MobileFileExplorer', () => ({
  MobileFileExplorer: () => null
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

import { MobileChatShell } from './MobileChatShell'

function renderShell(): void {
  render(
    <MemoryRouter>
      <MobileChatShell onNewChat={vi.fn()} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
    </MemoryRouter>
  )
}

describe('MobileChatShell token sweep (story 12)', () => {
  beforeEach(() => {
    tauriRef.current = false
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo' }
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
    editorRef.current.openFiles = new Map()
    browserTabsRef.current = new Map()
  })

  it('drawer width is ~70-75% of the viewport (w-[72vw]) capped at 20rem', () => {
    renderShell()
    fireEvent.click(screen.getByLabelText('Open menu'))

    const drawer = document.getElementById('mobile-chat-drawer')
    expect(drawer).not.toBeNull()
    const cls = drawer?.className ?? ''
    // The old width (w-[min(100vw-3rem,20rem)] ≈ 82% of a 390px viewport)
    // read as a page-jump. The sweep pins 72vw with a 20rem cap.
    expect(cls).toContain('w-[72vw]')
    expect(cls).toContain('max-w-20rem')
    expect(cls).not.toContain('100vw-3rem')
  })

  it('drawer header uses the p-2 family (no px-4 py-3 drift)', () => {
    renderShell()
    fireEvent.click(screen.getByLabelText('Open menu'))

    const drawer = document.getElementById('mobile-chat-drawer')
    expect(drawer).not.toBeNull()
    // SheetHeader renders a plain div — the drawer's first bordered section.
    const headerDiv = drawer?.querySelector('.border-b')
    expect(headerDiv).toBeTruthy()
    const cls = headerDiv?.className ?? ''
    expect(cls).toContain('p-2')
    // The drifting rhythms the QA report listed must be gone.
    expect(cls).not.toContain('px-4')
    expect(cls).not.toContain('px-3')
  })

  it('the chat search sits under an explicit Chats section label', () => {
    renderShell()
    fireEvent.click(screen.getByLabelText('Open menu'))

    // QA F12: the search input lives in ChatHistoryTab (chats only) but sat
    // unlabeled below the Terminals section — scope confusion. The drawer now
    // carries a Chats section header above the history tab.
    const drawer = document.getElementById('mobile-chat-drawer')
    expect(drawer).not.toBeNull()
    const label = Array.from(drawer?.querySelectorAll('.label-group') ?? []).find(
      (el) => el.textContent === 'Chats'
    )
    expect(label).toBeTruthy()
    // The label row sits ABOVE the ChatHistoryTab mount (scope clarifier).
    const history = drawer?.querySelector('[data-testid="chat-history-stub"]')
    expect(history).toBeTruthy()
    expect(
      label && history && label.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
