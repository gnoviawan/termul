import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeafNode, PaneNode } from '@/types/workspace.types'

// The store modules are mocked; the component reaches into `getState()`
// directly, so the mocks expose mutable state seams.
const {
  acpStateRef,
  acpIndexRef,
  activeProjectRef,
  findPaneContainingTab,
  workspaceRootRef,
  mockAddAgentChatTab,
  mockOpenHistorySession,
  mockNavigate,
  mockOpeningHistoryIds,
  mockRouteClosedChats,
  mockUseWorkspaceStore,
  mockUseAgentChatLifetimeStore
} = vi.hoisted(() => {
  // Tree walker mirroring the real exported helper; hoisted so the module
  // mock below can reuse it (recursive — needs a stable name).
  const findPaneContainingTab = (root: PaneNode, tabId: string): PaneNode | null => {
    if (root.type === 'leaf') return root.tabs.some((tab) => tab.id === tabId) ? root : null
    for (const child of root.children) {
      const found = findPaneContainingTab(child, tabId)
      if (found) return found
    }
    return null
  }
  // Mutable pane-tree seam: ChatRoute subscribes to the workspace root so a
  // wholesale tree swap (boot restore / project switch-back) re-fires the
  // activation effect. Tests drive a swap by assigning a new root object and
  // re-rendering — the selector reads the ref at call time.
  const workspaceRootRef = { current: null as PaneNode | null }
  // Lifetime-store seam backing the module mock's selector/getState (the
  // component no longer reads it — the closed-chat gate keys on acp-store
  // state — but the mock must stay shape-valid).
  const mockRetainedByProject = { current: {} as Record<string, string[]> }
  // Stateful addAgentChatTab: mirrors the real store against the mutable
  // root — inserts `chat-<id>` into the active leaf when absent (boot
  // restore dropped it), activates it, and never mutates when already
  // present+active+focused (the store guard's no-op). The idempotency
  // predicate itself stays in the real store; this mock only keeps the
  // state transitions the component's gate needs to observe.
  const mockAddAgentChatTab = vi.fn((sessionId: string): void => {
    const root = workspaceRootRef.current
    if (root?.type !== 'leaf') return
    const tabId = `chat-${sessionId}`
    if (root.tabs.some((tab) => tab.id === tabId)) {
      if (root.activeTabId === tabId) return
      workspaceRootRef.current = { ...root, activeTabId: tabId }
      return
    }
    const tab = { type: 'agent-chat', id: tabId, sessionId, mountKey: tabId } as const
    workspaceRootRef.current = {
      ...root,
      tabs: [...root.tabs, tab],
      activeTabId: tabId
    }
  })
  // Selector-capable store mock: `useWorkspaceStore((s) => s.root)` returns
  // the mutable seam; `getState()` serves the component's direct calls.
  const mockUseWorkspaceStore = Object.assign(
    vi.fn((selector: (s: { root: PaneNode | null }) => unknown) =>
      selector({ root: workspaceRootRef.current })
    ),
    { getState: () => ({ addAgentChatTab: mockAddAgentChatTab, root: workspaceRootRef.current }) }
  )
  // In-flight `openHistorySession` membership mirror (the reactive map the
  // store sets/clears around the open — session.ts:1552/1547). Distinguishes
  // "closed record because an open is running" from "closed because the
  // user closed the chat".
  const mockOpeningHistoryIds = { current: {} as Record<string, true> }
  // Route-closed chats seam (web-tab-session): requestCloseAgentChat marks a
  // closed chat here; ChatRoute consults + clears it. Mutable so tests can
  // simulate the user's close directly.
  const mockRouteClosedChats = { current: new Set<string>() }
  const mockUseAgentChatLifetimeStore = Object.assign(
    vi.fn((selector: (s: { retainedByProject: Record<string, string[]> }) => unknown) =>
      selector({ retainedByProject: mockRetainedByProject.current })
    ),
    { getState: () => ({ retainedByProject: mockRetainedByProject.current }) }
  )
  return {
    acpStateRef: { current: {} as Record<string, { status: string; projectId?: string }> },
    // Ownership seams: session index + the active project (foreign-route guard).
    acpIndexRef: { current: [] as Array<{ id: string; projectId: string }> },
    activeProjectRef: { current: 'p1' },
    findPaneContainingTab,
    workspaceRootRef,
    mockAddAgentChatTab,
    mockOpenHistorySession: vi.fn(),
    mockNavigate: vi.fn(),
    mockOpeningHistoryIds,
    mockRouteClosedChats,
    mockRetainedByProject,
    mockUseWorkspaceStore,
    mockUseAgentChatLifetimeStore
  }
})

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: Object.assign(
    vi.fn((selector: (s: { openHistorySession: unknown }) => unknown) =>
      selector({ openHistorySession: mockOpenHistorySession })
    ),
    {
      getState: () => ({
        sessions: acpStateRef.current,
        sessionIndex: acpIndexRef.current,
        openingHistoryIds: mockOpeningHistoryIds.current
      })
    }
  )
}))

// web-tab-session: route-scoped closed-chat signal (mutable Set seam).
vi.mock('@/lib/web-tab-session', () => ({
  markChatClosedOnRoute: (sessionId: string): void => {
    mockRouteClosedChats.current.add(sessionId)
  },
  isChatClosedOnRoute: (sessionId: string): boolean => mockRouteClosedChats.current.has(sessionId),
  clearChatClosedOnRoute: (sessionId: string): void => {
    mockRouteClosedChats.current.delete(sessionId)
  },
  getTabFocusedSessionId: (): null => null,
  setTabFocusedSessionId: (): void => {}
}))

// The store-level idempotency guard is the single source of truth; ChatRoute
// always delegates to addAgentChatTab and does not duplicate the predicate.
// Its mock is STATEFUL so follow-up effect runs see real tree state.
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: mockUseWorkspaceStore,
  findPaneContainingTab,
  agentChatTabId: (sessionId: string): string => `chat-${sessionId}`
}))

vi.mock('@/stores/agent-chat-lifetime-store', () => ({
  useAgentChatLifetimeStore: mockUseAgentChatLifetimeStore,
  retainedAgentChatSessionIds: (retainedByProject: Record<string, string[]>): Set<string> => {
    const ids = new Set<string>()
    for (const list of Object.values(retainedByProject)) {
      for (const id of list) ids.add(id)
    }
    return ids
  }
}))

vi.mock('@/lib/router-navigate', () => ({
  navigateToChatSession: mockNavigate,
  clearChatRoute: vi.fn()
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ activeProjectId: activeProjectRef.current }) }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import { ChatRoute } from '@/components/ChatRoute'
import { logFrontendError } from '@/lib/log-api'
import { clearChatRoute } from '@/lib/router-navigate'

type Rerender = (ui: ReactElement) => void

// Navigates once on mount (drives a real route change inside MemoryRouter —
// initialEntries only seed the first mount, so rerenders cannot change the
// route by themselves).
function RouteNavigate({ to }: { to: string }): null {
  const navigate = useNavigate()
  useEffect(() => {
    navigate(to)
  }, [navigate, to])
  return null
}

function renderChatRoute(path: string): { rerender: Rerender } {
  const { rerender } = render(
    <MemoryRouter initialEntries={[path]}>
      <ChatRoute />
    </MemoryRouter>
  )
  return { rerender }
}

function seedLiveSession(id: string): void {
  acpStateRef.current = { ...acpStateRef.current, [id]: { status: 'active' } }
}

// Replace the root (boot-restore swap / any root-identity mutation) and
// re-render ChatRoute on the same route so the effect re-runs.
function setRootAndRerender(rerender: Rerender, root: PaneNode, path: string): void {
  workspaceRootRef.current = root
  rerender(
    <MemoryRouter initialEntries={[path]}>
      <ChatRoute />
    </MemoryRouter>
  )
}

// User selects a sibling tab in the chat's pane (setActiveTab produces a
// new root identity) while the route stays current.
function selectSiblingTab(rerender: Rerender, leaf: LeafNode, tabId: string, path: string): void {
  setRootAndRerender(rerender, { ...leaf, activeTabId: tabId }, path)
}

// The chat's pane tree used across the swap tests: one leaf with the chat
// tab and a terminal sibling, chat active.
function leafWithChat(sessionId: string, id = 'pane-a'): LeafNode {
  const chatTabId = `chat-${sessionId}`
  return {
    type: 'leaf',
    id,
    tabs: [
      { type: 'terminal', id: 'term-t1', terminalId: 't1' },
      { type: 'agent-chat', id: chatTabId, sessionId, mountKey: chatTabId }
    ],
    activeTabId: chatTabId
  }
}

// A restored tree that dropped the chat tab (terminal-only leaf): the boot
// race state the fix targets.
const terminalOnlyRoot: PaneNode = { type: 'leaf', id: 'pane-b', tabs: [], activeTabId: null }

function chatTab(root: PaneNode | null, sessionId: string) {
  if (root?.type !== 'leaf') return undefined
  return root.tabs.find((tab) => tab.id === `chat-${sessionId}`)
}

function activeTabIdOf(root: PaneNode | null): string | null {
  return root?.type === 'leaf' ? root.activeTabId : null
}

describe('ChatRoute tab activation (multi-project perf)', () => {
  beforeEach(() => {
    mockAddAgentChatTab.mockClear()
    mockOpenHistorySession.mockReset()
    mockNavigate.mockReset()
    mockUseWorkspaceStore.mockClear()
    mockUseAgentChatLifetimeStore.mockClear()
    acpStateRef.current = {}
    acpIndexRef.current = []
    activeProjectRef.current = 'p1'
    vi.mocked(clearChatRoute).mockClear()
    vi.mocked(logFrontendError).mockClear()
    mockOpeningHistoryIds.current = {}
    mockRouteClosedChats.current = new Set<string>()
    workspaceRootRef.current = { type: 'leaf', id: 'pane-a', tabs: [], activeTabId: null }
  })

  it('delegates to addAgentChatTab for a live session (idempotency lives in the store guard)', () => {
    seedLiveSession('s-live')
    renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-live')
  })

  it('delegates once per route entry (two mounts of the same session → two calls)', () => {
    seedLiveSession('s-live')
    renderChatRoute('/c/s-live')
    // A second mount (e.g. strict-mode double effect) delegates again — the
    // component holds no predicate of its own; the store guard no-ops.
    renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
  })

  it('restores a not-yet-loaded session via openHistorySession before adding the tab', async () => {
    mockOpenHistorySession.mockResolvedValue(undefined)
    renderChatRoute('/c/s-restored')
    await vi.waitFor(() => {
      expect(mockOpenHistorySession).toHaveBeenCalledWith('s-restored')
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-restored')
    })
  })

  it('retries openHistorySession up to 5 times on failure before giving up', async () => {
    vi.useFakeTimers()
    mockOpenHistorySession.mockRejectedValue(new Error('not persisted yet'))
    renderChatRoute('/c/s-slow')
    // First attempt is immediate.
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500 * 4)
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(5)
    // After 5 failed attempts no tab activation happens.
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('ignores routes without a session id', () => {
    renderChatRoute('/')
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(mockOpenHistorySession).not.toHaveBeenCalled()
  })

  it('re-adds the chat tab when a root swap dropped it (boot-restore win kept)', () => {
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')
    // First run inserted + activated the chat tab into the empty pane.
    expect(chatTab(workspaceRootRef.current, 's-live')).toBeDefined()
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')

    // Boot restore (manifest / legacy paneLayout) replaces the tree after
    // the first effect run and the restored tree has no chat tab — the
    // route re-delegates, the store inserts it, and the chat becomes the
    // active tab again (route wins the race without further navigation).
    setRootAndRerender(rerender, terminalOnlyRoot, '/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    expect(mockAddAgentChatTab).toHaveBeenLastCalledWith('s-live')
    expect(chatTab(workspaceRootRef.current, 's-live')).toBeDefined()
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')
  })

  it('does not snap back when the user selects a sibling tab while the route is current', () => {
    seedLiveSession('s-live')
    const restored = leafWithChat('s-live', 'pane-b')
    workspaceRootRef.current = restored
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    const leafAfterActivation = workspaceRootRef.current as LeafNode

    // A tab click IS a user interaction: close the boot window first so
    // the pane-id gate owns the decision.
    window.dispatchEvent(new Event('pointerdown'))
    // The user clicks the terminal tab in the chat's pane: setActiveTab
    // produces a new root identity — user intent, not a boot race.
    selectSiblingTab(rerender, leafAfterActivation, 'term-t1', '/c/s-live')
    // No further delegation: the chat tab exists (inactive), so the gate
    // leaves the tree alone and the terminal stays the active tab.
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('term-t1')
  })

  it('re-activates after a same-pane terminal steal during the boot window (no interaction yet)', () => {
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')
    const leafAfterActivation = workspaceRootRef.current as LeafNode

    // The boot race the pane-id gate cannot see: openHistorySession is
    // async, and useTerminalRestore's live-PTY path activates the persisted
    // terminal in the SAME pane (its hasValidActiveAgentChatTab guard read
    // acp-store before the session record installed). No user interaction
    // has happened — the boot window is still open.
    setRootAndRerender(rerender, { ...leafAfterActivation, activeTabId: 'term-t1' }, '/c/s-live')

    // The route outranks boot machinery: it re-delegates and the chat
    // becomes the active tab again.
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')
  })

  it('does not re-delegate after a same-pane steal once the user has interacted', () => {
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    const leafAfterActivation = workspaceRootRef.current as LeafNode

    // The user interacts (any pointerdown/keydown closes the boot window);
    // the pane-id gate now owns the decision.
    window.dispatchEvent(new Event('keydown'))

    // Same same-pane steal as above, but now post-interaction: user
    // territory — the gate refuses and the terminal stays active.
    setRootAndRerender(rerender, { ...leafAfterActivation, activeTabId: 'term-t1' }, '/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('term-t1')
  })

  it('re-activates the chat when boot restore rebuilds the tree after the mount delegation (ordering b)', () => {
    seedLiveSession('s-live')
    // Mount on the default tree: the first effect run adds + activates the
    // chat tab into pane-a (the default pane ChatRoute's delegation lands in).
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')

    // The editor-persistence restore completes AFTER the mount delegation:
    // loadProjectWorkspace wholesale-replaces the tree with all-new pane
    // ids, and reattachOpenAgentChats re-inserts the chat tab without
    // activating it — the manifest's terminal tab stays active.
    const rebuilt = leafWithChat('s-live', 'pane-restored')
    setRootAndRerender(rerender, { ...rebuilt, activeTabId: 'term-t1' }, '/c/s-live')

    // The chat tab's pane id changed (pane-restored vs pane-a) = tree
    // rebuild, not user intent → the route re-delegates and the chat
    // becomes the active tab again (boot-race ordering b: ChatRoute wins
    // without any further navigation).
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    expect(mockAddAgentChatTab).toHaveBeenLastCalledWith('s-live')
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')
  })

  it('does not resurrect a chat closed while its route stayed current', async () => {
    // The reload path: no session in acp-store yet, none retained — mount
    // still opens (openHistorySession branch), coalesced.
    mockOpenHistorySession.mockResolvedValue(undefined)
    const { rerender } = renderChatRoute('/c/s-closed')
    await vi.waitFor(() => {
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-closed')
    })
    expect(chatTab(workspaceRootRef.current, 's-closed')).toBeDefined()

    // The user closes the chat: requestCloseAgentChat marks it closed on
    // this route (the synchronous signal), releases the lifetime retention,
    // removes the tab — and the route stays `#/c/s-closed`. The record
    // lingers with status 'closed' (closeSession mutates the status).
    mockRouteClosedChats.current.add('s-closed')
    acpStateRef.current = { 's-closed': { status: 'closed' } }
    mockOpeningHistoryIds.current = {}
    workspaceRootRef.current = terminalOnlyRoot

    // A later root swap must not re-open the released session.
    setRootAndRerender(rerender, { ...terminalOnlyRoot, id: 'pane-c' }, '/c/s-closed')
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(1)
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(chatTab(workspaceRootRef.current, 's-closed')).toBeUndefined()
  })

  it('does not resurrect a chat closed while the mount-time open was still in flight', async () => {
    // The P2 race: the mount open is IN FLIGHT (openingHistoryIds marked,
    // record installed as 'closed' mid-open) when the user closes the chat.
    // The closed-on-route mark must still suppress the re-open — a
    // record+in-flight heuristic could not tell this close from the reload
    // open it exempted.
    const inFlight = new Map<string, Promise<void>>()
    let resolveOpen: (() => void) | undefined
    mockOpenHistorySession.mockImplementation((id: string) => {
      const existing = inFlight.get(id)
      if (existing) return existing
      const task = new Promise<void>((resolve) => {
        resolveOpen = resolve
      })
      inFlight.set(id, task)
      return task
    })
    const { rerender } = renderChatRoute('/c/s-race')
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(1)

    // User closes mid-open: the mark fires (requestCloseAgentChat), the tab
    // is removed, a root swap re-runs the effect — still inside the
    // in-flight window (record 'closed', openingHistoryIds set).
    mockRouteClosedChats.current.add('s-race')
    acpStateRef.current = { 's-race': { status: 'closed' } }
    mockOpeningHistoryIds.current = { 's-race': true }
    workspaceRootRef.current = terminalOnlyRoot
    setRootAndRerender(rerender, { ...terminalOnlyRoot, id: 'pane-c' }, '/c/s-race')

    // No second (non-coalesced) open, no tab resurrection.
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(1)
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()

    resolveOpen?.()
    await inFlight.get('s-race')
    // The cancelled first run never activates the tab.
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(chatTab(workspaceRootRef.current, 's-race')).toBeUndefined()
  })

  it('re-opens a previously closed history chat when navigating to its route from another chat', async () => {
    // The P1 route-change bug: chat A is live on its route; chat B was
    // closed while on ITS route in an earlier visit — its closed-on-route
    // mark (module-level, survives ChatRoute unmount) and its lingering
    // 'closed' record both exist. Navigating from A's route to B's route
    // must re-open B: the mark is cleared by the re-open, the tab is
    // re-added, and the suppression from the old visit does not carry over.
    acpStateRef.current = { 's-a': { status: 'active' }, 's-b': { status: 'closed' } }
    // The user closed B on its own route earlier (mark survives unmount).
    mockRouteClosedChats.current.add('s-b')
    mockOpenHistorySession.mockResolvedValue(undefined)

    const { rerender } = renderChatRoute('/c/s-a')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(mockAddAgentChatTab).toHaveBeenLastCalledWith('s-a')

    // Navigate to B's chat route (route target change). MemoryRouter's
    // initialEntries only seed the first mount, so drive the navigation
    // through the router's history (what a real hash change does).
    rerender(
      <MemoryRouter>
        <RouteNavigate to="/c/s-b" />
        <ChatRoute />
      </MemoryRouter>
    )
    // RouteNavigate commits in an effect — wait for the navigation to land.
    // The mount-run on the new route target re-opens B from history (the
    // mark alone must not suppress the FIRST run) and the tab is re-added;
    // the successful re-open then clears the stale mark.
    await vi.waitFor(() => {
      expect(mockOpenHistorySession).toHaveBeenCalledWith('s-b')
    })
    await vi.waitFor(() => {
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-b')
    })
    expect(chatTab(workspaceRootRef.current, 's-b')).toBeDefined()
    expect(mockRouteClosedChats.current.has('s-b')).toBe(false)

    // With the mark cleared by the re-open, a later pane-tree change still
    // re-delegates (the stale mark no longer suppresses reactivation).
    const leafAfterReopen = workspaceRootRef.current as LeafNode
    window.dispatchEvent(new Event('pointerdown'))
    setRootAndRerender(rerender, { ...leafAfterReopen, id: 'pane-swapped' }, '/c/s-b')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(3)
    expect(mockAddAgentChatTab).toHaveBeenLastCalledWith('s-b')
  })

  it('clears a stale closed-on-route mark when the chat re-opens after an unmount round-trip', async () => {
    // The module-level mark survives ChatRoute unmount (navigating to a
    // non-chat route does not run the component's departure reset). On the
    // return mount the first run is exempt, but a LATER tree change would
    // hit the stale mark — the re-open must clear it so reactivation works.
    mockOpenHistorySession.mockResolvedValue(undefined)
    // B was closed on its route, then the user left the chat routes entirely
    // (ChatRoute unmounted; the mark persisted).
    mockRouteClosedChats.current.add('s-b')
    acpStateRef.current = { 's-b': { status: 'closed' } }

    const { rerender } = renderChatRoute('/c/s-b')
    await vi.waitFor(() => {
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-b')
    })
    expect(mockRouteClosedChats.current.has('s-b')).toBe(false)

    // Post-interaction tree rebuild still re-delegates (no stale mark).
    window.dispatchEvent(new Event('pointerdown'))
    setRootAndRerender(rerender, terminalOnlyRoot, '/c/s-b')
    await vi.waitFor(() => {
      expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    })
  })

  it('re-delegates after interaction when the chat tab is absent (interacted-window branch)', () => {
    // P3 coverage: after the first interaction, the same-pane block is NOT
    // the only rule — an ABSENT chat tab (boot restore dropped it after the
    // user started interacting) still re-delegates.
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)

    // User interacts (closes the boot window).
    window.dispatchEvent(new Event('pointerdown'))

    // A later restore drops the chat tab from the tree entirely.
    setRootAndRerender(rerender, terminalOnlyRoot, '/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    expect(mockAddAgentChatTab).toHaveBeenLastCalledWith('s-live')
    expect(chatTab(workspaceRootRef.current, 's-live')).toBeDefined()
  })

  it('re-delegates after interaction when the chat tab moved to a different pane (interacted-window branch)', () => {
    // P3 coverage: a wholesale rebuild that moves the chat tab to a NEW pane
    // id (tree rebuilt while the user has interacted) still re-delegates.
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    const leafAfterFirst = workspaceRootRef.current as LeafNode

    window.dispatchEvent(new Event('pointerdown'))

    // Same tree content but a DIFFERENT pane id (rebuilt tree).
    setRootAndRerender(rerender, { ...leafAfterFirst, id: 'pane-rebuilt' }, '/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')
  })

  it('still re-activates a live session after a root swap (project switch-back)', () => {
    // The session lives in acp-store with a live status (turn still running
    // server-side) — the closed-record gate does not apply.
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')

    // Project switch-back: the tree is replaced with one that dropped the
    // chat tab while the route stays `#/c/<id>` → the chat re-activates.
    setRootAndRerender(rerender, terminalOnlyRoot, '/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
    expect(activeTabIdOf(workspaceRootRef.current)).toBe('chat-s-live')
  })

  it('settles without an effect loop once the chat tab is present', () => {
    seedLiveSession('s-live')
    const { rerender } = renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    // First run inserted + activated the tab.
    const leafAfterFirst = workspaceRootRef.current as LeafNode

    // The settling phase is post-interaction: close the boot window so the
    // pane-id gate owns the decision.
    window.dispatchEvent(new Event('pointerdown'))

    // Any later root identity change with the SAME pane id (the store
    // guard's activation set() on a non-no-op run, a sibling split
    // reusing the pane, focus changes) re-runs the effect, but the tab
    // is present in the pane the effect already saw → no delegation →
    // the dep settles.
    setRootAndRerender(rerender, { ...leafAfterFirst }, '/c/s-live')
    setRootAndRerender(rerender, { ...leafAfterFirst }, '/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
  })

  it('coalesces the uncached open into one in-flight promise across a root swap', async () => {
    // Mirrors acp-store's `inFlightHistoryOpens`: while an open is in
    // flight, further calls for the same session return the SAME promise —
    // that map remains the only concurrency control on the async open path
    // (ChatRoute adds no lock of its own).
    const inFlight = new Map<string, Promise<void>>()
    let tasksStarted = 0
    let resolveOpen: (() => void) | undefined
    mockOpenHistorySession.mockImplementation((id: string) => {
      const existing = inFlight.get(id)
      if (existing) return existing
      tasksStarted++
      const task = new Promise<void>((resolve) => {
        resolveOpen = resolve
      })
      inFlight.set(id, task)
      return task
    })

    // acp-store installs the session record (status 'closed' until the
    // resume completes — session.ts:1592) AND marks the open in
    // `openingHistoryIds` (session.ts:1552) while it is in flight, so the
    // gate's closed-chat check sees a live open, not a released chat.
    acpStateRef.current = { 's-restored': { status: 'closed' } }
    mockOpeningHistoryIds.current = { 's-restored': true }
    const { rerender } = renderChatRoute('/c/s-restored')
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(1)
    expect(tasksStarted).toBe(1)

    // The boot race: the tree swaps while the open is in flight. The effect
    // re-runs (a fresh 5-attempt budget per effect run) and re-delegates,
    // but the store coalesces — both calls resolve to the SAME in-flight
    // promise, still exactly one underlying open task.
    setRootAndRerender(rerender, { ...terminalOnlyRoot, id: 'pane-c' }, '/c/s-restored')
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(2)
    expect(tasksStarted).toBe(1)
    expect(mockOpenHistorySession.mock.results[1]?.value).toBe(
      mockOpenHistorySession.mock.results[0]?.value
    )

    // Nothing activates while the open is in flight; the first (cancelled)
    // effect run never reaches addAgentChatTab.
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()

    resolveOpen?.()
    await inFlight.get('s-restored')
    await vi.waitFor(() => {
      expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    })
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-restored')
    // One in-flight promise survived the whole swap sequence.
    expect(tasksStarted).toBe(1)
  })

  describe('foreign-project route guard', () => {
    it('does not insert a live chat owned by another project; clears the route instead', () => {
      acpStateRef.current = { 's-a': { status: 'active', projectId: 'p2' } }
      renderChatRoute('/c/s-a')
      expect(mockAddAgentChatTab).not.toHaveBeenCalled()
      expect(clearChatRoute).toHaveBeenCalledWith('s-a')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'ChatRoute' })
      )
      expect(chatTab(workspaceRootRef.current, 's-a')).toBeUndefined()
    })

    it('does not open a history chat the index attributes to another project', () => {
      acpIndexRef.current = [{ id: 's-a', projectId: 'p2' }]
      renderChatRoute('/c/s-a')
      expect(mockOpenHistorySession).not.toHaveBeenCalled()
      expect(mockAddAgentChatTab).not.toHaveBeenCalled()
      expect(clearChatRoute).toHaveBeenCalledWith('s-a')
    })

    it('skips the insert when the opened record reveals a foreign owner', async () => {
      mockOpenHistorySession.mockImplementation(async (id: string) => {
        acpStateRef.current = { [id]: { status: 'active', projectId: 'p2' } }
      })
      renderChatRoute('/c/s-a')
      await vi.waitFor(() => expect(clearChatRoute).toHaveBeenCalledWith('s-a'))
      expect(mockOpenHistorySession).toHaveBeenCalledWith('s-a')
      expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    })

    it('inserts chats owned by the active project, unattributed stubs, and before a project is active', () => {
      acpStateRef.current = {
        's-own': { status: 'active', projectId: 'p1' },
        's-stub': { status: 'active', projectId: '' },
        's-other': { status: 'active', projectId: 'p2' }
      }
      renderChatRoute('/c/s-own')
      renderChatRoute('/c/s-stub')
      activeProjectRef.current = ''
      renderChatRoute('/c/s-other')
      expect(mockAddAgentChatTab.mock.calls.map(([id]) => id)).toEqual([
        's-own',
        's-stub',
        's-other'
      ])
      expect(clearChatRoute).not.toHaveBeenCalled()
    })
  })
})
