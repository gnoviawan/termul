import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, warning: toastWarning }
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/acp-agents-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    // Read-through the module-level cache so tests can seed payloads via
    // setCachedSessionPayload (preferred over per-test mockResolvedValue).
    loadSessionPayload: vi.fn(async (id: string) => actual.getCachedSessionPayload(id) ?? null),
    // Tail-first: the store calls `loadSessionPayloadTail` first, then falls
    // back to `loadSessionPayload`. Mock both to the same cache-backed fn so
    // per-test `mockResolvedValueOnce` on `loadSessionPayload` still fires
    // (the tail mock returns null when no cache is seeded → fallback runs).
    // The CAP-7 chain walk uses the (cache-backed) full loader for hop
    // resolution — the tail mock's null never blocks it.
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})

// Spies for the switch-back reopen branch (addAgentChatTab +
// setTabFocusedSessionId). `getTabFocusedSessionId` returns null so
// switchProject falls back to `activeSessionId` (matching the real behavior
// when no tab focus is set). `workspaceStateRef` is the fake surface for the
// corpse-tab prune (loadSessionIndex) + failed-launch tab remap
// (retryFailedLaunch): seed `.root` with pane trees and observe the spies.
const { addAgentChatTabSpy, setTabFocusedSessionIdSpy, workspaceStateRef } = vi.hoisted(() => ({
  addAgentChatTabSpy: vi.fn(),
  setTabFocusedSessionIdSpy: vi.fn(),
  workspaceStateRef: {
    current: {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
  }
}))

vi.mock('@/stores/workspace-store', () => {
  // Local mirrors of the real pane helpers (importing the real module would
  // drag terminal-store/router side effects into this suite).
  type PaneNodeLike = {
    type: string
    tabs?: Array<{ type: string; id: string; sessionId?: string }>
    children?: PaneNodeLike[]
  }
  const getAllLeafPanes = (root: PaneNodeLike): PaneNodeLike[] =>
    root.type === 'leaf' ? [root] : (root.children ?? []).flatMap(getAllLeafPanes)
  const findPaneContainingTab = (root: PaneNodeLike, tabId: string): PaneNodeLike | null => {
    for (const leaf of getAllLeafPanes(root)) {
      if ((leaf.tabs ?? []).some((t) => t.id === tabId)) return leaf
    }
    return null
  }
  return {
    getAllLeafPanes,
    findPaneContainingTab,
    agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
    useWorkspaceStore: {
      getState: () => ({
        addAgentChatTab: addAgentChatTabSpy,
        removeTab: workspaceStateRef.current.removeTab,
        remapAgentChatSession: workspaceStateRef.current.remapAgentChatSession,
        root: workspaceStateRef.current.root
      })
    }
  }
})

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: setTabFocusedSessionIdSpy,
  getTabFocusedSessionId: vi.fn(() => null)
}))

// Mock persistenceApi so composer-selection persistence calls are observable
// in tests without hitting the Tauri plugin-store transport. Preserve other
// `@/lib/api` exports via importActual so transitive imports still resolve.
const { mockPersistenceApi, mockListCatalog } = vi.hoisted(() => ({
  mockPersistenceApi: {
    // Defaults reproduce the implementation leak the single-file suite relied
    // on; tests override per-test via mockResolvedValue(Once) as before.
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    // Story 3 (spec-in-chat-agent-switch): the switch clears the old
    // session's composer draft via persistenceApi.delete.
    delete: vi.fn(async () => ({ success: true }))
  },
  mockListCatalog: vi.fn()
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: mockPersistenceApi,
    acpCatalogApi: { ...actual.acpCatalogApi, listCatalog: mockListCatalog }
  }
})

import { invoke } from '@tauri-apps/api/core'
import type { PlanEntry } from '@/lib/acp-api'
import { getCachedSessionPayload, setCachedSessionPayload } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { type ChatMessage, useAcpStore } from '@/stores/acp-store'
import { FRESH, seedSession } from './testkit'

describe('ACP agent plan store', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
  })

  it('_onPlanUpdate replaces entries and empty update clears plan', () => {
    seedSession('sess-1', 'agent-1', false)
    useAcpStore.getState()._onPlanUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      plan: {
        entries: [{ content: 'step one', status: 'pending', priority: 'high' }]
      }
    })
    expect(useAcpStore.getState().plans['sess-1']).toHaveLength(1)

    useAcpStore.getState()._onPlanUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      plan: { entries: [] }
    })
    expect(useAcpStore.getState().plans['sess-1']).toBeUndefined()
  })

  it('closeSession clears cached plan for the session', async () => {
    seedSession('sess-1', 'agent-1', false)
    useAcpStore.setState({
      plans: {
        'sess-1': [{ content: 'old plan', status: 'completed' }]
      }
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-1')
    expect(useAcpStore.getState().plans['sess-1']).toBeUndefined()
  })

  it('closeSession attempts close when capabilities are missing and skips a loaded snapshot without close', async () => {
    seedSession('sess-unknown', 'agent-1', false)
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-unknown')
    expect(invoke).toHaveBeenCalledWith('acp_close_session', {
      agentId: 'agent-1',
      sessionId: 'sess-unknown'
    })

    seedSession('sess-no-close', 'agent-2', false)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-2': {
          id: 'agent-2',
          capabilities: { loadSession: true, sessionCapabilities: {} }
        }
      }
    }))
    vi.mocked(invoke).mockClear()
    await useAcpStore.getState().closeSession('sess-no-close')
    expect(invoke).not.toHaveBeenCalledWith('acp_close_session', expect.anything())
  })

  it('logs close failures while still closing the session locally', async () => {
    seedSession('sess-close-failure', 'agent-1', false)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('agent rejected session/close'))

    await useAcpStore.getState().closeSession('sess-close-failure')

    expect(logFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'acp.closeSession',
      message: 'Failed to close session sess-close-failure: Error: agent rejected session/close'
    })
    expect(useAcpStore.getState().sessions['sess-close-failure']?.status).toBe('closed')
  })

  it('_onSessionClosed clears cached plan for the session', () => {
    seedSession('sess-1', 'agent-1', false)
    useAcpStore.setState({
      plans: {
        'sess-1': [{ content: 'old plan', status: 'completed' }]
      }
    })
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 'sess-1' })
    expect(useAcpStore.getState().plans['sess-1']).toBeUndefined()
  })

  // --- Plan persistence + sticky snapshot (spec: plan-persistence-sticky-snapshot) ---

  it('sendPrompt preserves plans[sessionId] across a new prompt turn', async () => {
    seedSession('sess-1', 'agent-1', false)
    const plan: PlanEntry[] = [
      { content: 'step one', status: 'in_progress', priority: 'high' },
      { content: 'step two', status: 'pending', priority: 'medium' }
    ]
    useAcpStore.setState({ plans: { 'sess-1': plan } })
    // never resolve so the turn stays active for the assertion
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    void useAcpStore.getState().sendPrompt('sess-1', 'follow up')
    await Promise.resolve()
    // Plan must NOT be cleared by sendPrompt (only _onPlanUpdate empty entries clears it)
    expect(useAcpStore.getState().plans['sess-1']).toBe(plan)
  })

  it('_onPromptComplete appends a termul-plan fence to the last assistant message when plans[sessionId] is non-empty', () => {
    seedSession('sess-1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'do work' }],
            streaming: false,
            timestamp: 0,
            seq: 1
          },
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [{ type: 'text', text: 'working on it' }],
            streaming: true,
            timestamp: 1,
            seq: 2
          }
        ]
      },
      plans: {
        'sess-1': [
          { content: 'Read AC file', status: 'completed', priority: 'high' },
          { content: 'Fix bug', status: 'in_progress', priority: 'high' }
        ]
      }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const msgs = useAcpStore.getState().messages['sess-1']
    const lastAgent = [...msgs].reverse().find((m) => m.role === 'agent')
    expect(lastAgent).toBeDefined()
    // The fence block must be the last block on the just-finished assistant message
    const fenceBlock = lastAgent!.blocks.find(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )
    expect(fenceBlock).toBeDefined()
    // Non-fence text blocks (the agent's reply prose) must survive the
    // appendPlanSnapshot filter — regression guard against a filter that
    // accidentally drops all text blocks.
    expect(lastAgent!.blocks).toHaveLength(2)
    // The preceding prose block gains a trailing newline so the fence opener
    // sits on its own line (CommonMark fence requirement). Without it, the
    // joined text "working on it```termul-plan" is not recognized as a fence
    // and the snapshot renders as plain text instead of a PlanPanel.
    expect(lastAgent!.blocks.find((b) => b.text === 'working on it\n')).toBeDefined()
    // The fence JSON decodes to the original PlanEntry[]
    const json = (fenceBlock!.text as string).replace(/^```termul-plan\n/, '').replace(/\n```$/, '')
    expect(JSON.parse(json)).toEqual([
      { content: 'Read AC file', status: 'completed', priority: 'high' },
      { content: 'Fix bug', status: 'in_progress', priority: 'high' }
    ])
    // streaming flag flipped by finalizeStreaming
    expect(lastAgent!.streaming).toBe(false)
    // Regression guard: when blocksToText joins the prose + fence with '', the
    // fence opener must be at the start of a line so Streamdown recognizes it.
    const joined = lastAgent!.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    expect(/(^|\n)```termul-plan/.test(joined)).toBe(true)
  })

  it('_onPromptComplete normalizes the last non-empty text block even when a non-text block follows it', () => {
    // blocksToText skips non-text blocks (images, resources) when joining, so
    // the block that ends up immediately before the fence in the joined text is
    // the last TEXT block — not the last array element. The boundary newline
    // must be applied to that text block, or the fence opener stays glued.
    seedSession('sess-1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [
              { type: 'text', text: 'working on it' },
              { type: 'image', source: { uri: 'file:///x.png', mediaType: 'image/png' } }
            ],
            streaming: true,
            timestamp: 0,
            seq: 1
          }
        ]
      },
      plans: { 'sess-1': [{ content: 'task', status: 'completed' }] }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const lastAgent = useAcpStore.getState().messages['sess-1'].find((m) => m.role === 'agent')!
    // The text block (not the image) gained the trailing newline boundary.
    expect(lastAgent.blocks.find((b) => b.text === 'working on it\n')).toBeDefined()
    // The joined text has the fence opener at the start of a line.
    const joined = lastAgent.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    expect(/(^|\n)```termul-plan/.test(joined)).toBe(true)
  })

  it('_onPromptComplete writes no fence when plans[sessionId] is empty (non-compliant agent)', () => {
    seedSession('sess-1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [{ type: 'text', text: 'reply' }],
            streaming: true,
            timestamp: 0,
            seq: 1
          }
        ]
      },
      plans: {}
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const lastAgent = useAcpStore.getState().messages['sess-1'].find((m) => m.role === 'agent')!
    expect(
      lastAgent.blocks.some((b) => b.type === 'text' && b.text?.startsWith('```termul-plan\n'))
    ).toBe(false)
  })

  it('_onPromptComplete replaces a prior termul-plan fence on the same message (one fence per assistant message)', () => {
    seedSession('sess-1', 'agent-1', true)
    const priorFence = '```termul-plan\n[{"content":"old","status":"completed"}]\n```'
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [
              { type: 'text', text: 'reply' },
              { type: 'text', text: priorFence }
            ],
            streaming: true,
            timestamp: 0,
            seq: 1
          }
        ]
      },
      plans: {
        'sess-1': [{ content: 'new plan', status: 'in_progress', priority: 'high' }]
      }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const lastAgent = useAcpStore.getState().messages['sess-1'].find((m) => m.role === 'agent')!
    const fences = lastAgent.blocks.filter(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )
    // Exactly one fence — the prior one was replaced, not appended
    expect(fences).toHaveLength(1)
    const json = (fences[0]!.text as string).replace(/^```termul-plan\n/, '').replace(/\n```$/, '')
    expect(JSON.parse(json)).toEqual([
      { content: 'new plan', status: 'in_progress', priority: 'high' }
    ])
  })

  it('_onPromptComplete survives a JSON.stringify failure in appendPlanSnapshot without blocking turn-end (logs source: planSnapshot)', () => {
    // A PlanEntry mutated to carry a circular reference would make
    // JSON.stringify throw. The try/catch in _onPromptComplete logs to
    // source: 'planSnapshot' and continues — the live sticky plan still
    // covers the turn.
    seedSession('sess-circular', 'agent-1', true)
    const circular: PlanEntry = { content: 'bad', status: 'in_progress' } as PlanEntry
    ;(circular as unknown as { self: unknown }).self = circular
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-circular': [
          {
            id: 'm-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'do work' }],
            streaming: false,
            timestamp: 0,
            seq: 1
          },
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [{ type: 'text', text: 'working on it' }],
            streaming: true,
            timestamp: 1,
            seq: 2
          }
        ]
      },
      plans: { 'sess-circular': [circular] }
    }))
    // Must not throw
    expect(() =>
      useAcpStore.getState()._onPromptComplete({
        agentId: 'agent-1',
        sessionId: 'sess-circular',
        stopReason: 'end_turn'
      })
    ).not.toThrow()
    // The agent's reply prose survives; no fence was appended (stringify threw).
    const lastAgent = useAcpStore
      .getState()
      .messages['sess-circular'].find((m) => m.role === 'agent')!
    expect(lastAgent.blocks.find((b) => b.text === 'working on it')).toBeDefined()
    expect(lastAgent.blocks.some((b) => b.text?.startsWith('```termul-plan'))).toBe(false)
  })

  it('_onPromptComplete updates the in-memory payload cache so a same-session rehydrate finds the fence (CAP-2 host-owned history)', async () => {
    // Seed the cache with a payload that has NO fence — this is the state
    // after the host has written the turn's `message_chunk`/`user_prompt`
    // records but before the renderer has snapshot the plan.
    seedSession('sess-cache', 'agent-1', true)
    const baseMessages: ChatMessage[] = [
      {
        id: 'm-user',
        role: 'user',
        blocks: [{ type: 'text', text: 'do work' }],
        streaming: false,
        timestamp: 0,
        seq: 1
      },
      {
        id: 'm-agent',
        role: 'agent',
        blocks: [{ type: 'text', text: 'working on it' }],
        streaming: true,
        timestamp: 1,
        seq: 2
      }
    ]
    setCachedSessionPayload('sess-cache', {
      metadata: {
        id: 'sess-cache',
        agentId: 'agent-1',
        title: 'T',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 2,
        status: 'active' as const
      },
      messages: baseMessages
    })
    useAcpStore.setState((s) => ({
      messages: { ...s.messages, 'sess-cache': baseMessages },
      plans: {
        'sess-cache': [{ content: 'cache task', status: 'in_progress', priority: 'high' }]
      }
    }))

    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-cache',
      stopReason: 'end_turn'
    })

    // The cache must now reflect the fence-appended messages so a subsequent
    // loadSessionPayload (within the same app session) finds the fence.
    const cached = getCachedSessionPayload('sess-cache')
    expect(cached).toBeDefined()
    const cachedAgent = [...cached!.messages].reverse().find((m) => m.role === 'agent')
    expect(cachedAgent).toBeDefined()
    const cachedFence = cachedAgent!.blocks.find(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )
    expect(cachedFence).toBeDefined()
    // The live store and the cache must agree on the fence content.
    const storeAgent = useAcpStore
      .getState()
      .messages['sess-cache'].find((m) => m.role === 'agent')!
    const storeFence = storeAgent.blocks.find(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )!
    expect(cachedFence!.text).toBe(storeFence.text)
  })

  it('openHistorySession repopulates plans[id] from the latest termul-plan fence in the last assistant message', async () => {
    const plan: PlanEntry[] = [
      { content: 'historical task', status: 'completed', priority: 'high' },
      { content: 'next step', status: 'in_progress', priority: 'medium' }
    ]
    const fence = '```termul-plan\n' + JSON.stringify(plan) + '\n```'
    setCachedSessionPayload('sess-rehydrate', {
      metadata: {
        id: 'sess-rehydrate',
        agentId: 'agent-x',
        title: 'Rehydrated',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-user',
          role: 'user',
          blocks: [{ type: 'text', text: 'do work' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        },
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [
            { type: 'text', text: 'reply' },
            { type: 'text', text: fence }
          ],
          streaming: false,
          timestamp: 1,
          seq: 2
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('sess-rehydrate')
    expect(useAcpStore.getState().plans['sess-rehydrate']).toEqual(plan)
  })

  it('openHistorySession leaves plans[id] empty and warns when the fence JSON is malformed', async () => {
    setCachedSessionPayload('sess-malformed', {
      metadata: {
        id: 'sess-malformed',
        agentId: 'agent-x',
        title: 'Malformed',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-user',
          role: 'user',
          blocks: [{ type: 'text', text: 'do work' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        },
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [{ type: 'text', text: '```termul-plan\n{not valid json}\n```' }],
          streaming: false,
          timestamp: 1,
          seq: 2
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('sess-malformed')
    expect(useAcpStore.getState().plans['sess-malformed']).toBeUndefined()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'planRehydrate' })
    )
  })

  it('openHistorySession does not overwrite a live plans[id] from an in-flight turn', async () => {
    const livePlan: PlanEntry[] = [{ content: 'live', status: 'in_progress', priority: 'high' }]
    const fence =
      '```termul-plan\n' + JSON.stringify([{ content: 'fence', status: 'completed' }]) + '\n```'
    setCachedSessionPayload('sess-live', {
      metadata: {
        id: 'sess-live',
        agentId: 'agent-x',
        title: 'Live',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [{ type: 'text', text: fence }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ]
    })
    seedSession('sess-live', 'agent-x', true)
    useAcpStore.setState({ plans: { 'sess-live': livePlan } })
    await useAcpStore.getState().openHistorySession('sess-live')
    // Live plan from the in-flight turn wins; the fence does not overwrite it
    expect(useAcpStore.getState().plans['sess-live']).toBe(livePlan)
  })

  it('openHistorySession last-fence-wins when two termul-plan fences are in the same assistant message', async () => {
    const first =
      '```termul-plan\n' + JSON.stringify([{ content: 'first', status: 'completed' }]) + '\n```'
    const second =
      '```termul-plan\n' + JSON.stringify([{ content: 'second', status: 'in_progress' }]) + '\n```'
    setCachedSessionPayload('sess-twofence', {
      metadata: {
        id: 'sess-twofence',
        agentId: 'agent-x',
        title: 'Two fences',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-user',
          role: 'user',
          blocks: [{ type: 'text', text: 'do work' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        },
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [
            { type: 'text', text: 'reply' },
            { type: 'text', text: first },
            { type: 'text', text: second }
          ],
          streaming: false,
          timestamp: 1,
          seq: 2
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('sess-twofence')
    expect(useAcpStore.getState().plans['sess-twofence']).toEqual([
      { content: 'second', status: 'in_progress' }
    ])
  })
})
