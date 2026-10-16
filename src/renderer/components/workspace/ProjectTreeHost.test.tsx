/**
 * AD-13: every visited project's tree stays mounted, only the active one is
 * visible, and a hidden tree neither re-renders for the active project's
 * notifications nor shows another project's editor content.
 *
 * Real workspace / terminal / acp stores and the real PaneRenderer + PaneContent
 * drive the trees; only the heavy leaf panels are stubbed with probes that
 * count mounts and renders.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/stores/acp-store'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  createProjectWorkspace,
  type ProjectWorkspace,
  useWorkspaceStore
} from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'

const { probes } = vi.hoisted(() => ({
  probes: {
    chatMounts: {} as Record<string, number>,
    chatRenders: {} as Record<string, number>,
    chatVisible: {} as Record<string, boolean>,
    chatMessageCount: {} as Record<string, number>,
    terminalMounts: {} as Record<string, number>,
    terminalVisible: {} as Record<string, boolean>
  }
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => false }))
vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ isDragging: false, previewTarget: null, lastDrop: null })
}))
vi.mock('@/components/workspace/WorkspaceTabBar', () => ({
  WorkspaceTabBar: () => <div data-testid="tabbar-stub" />
}))
vi.mock('@/components/workspace/DropZoneOverlay', () => ({ DropZoneOverlay: () => null }))
vi.mock('@/components/agents/AgentLauncher', () => ({
  AgentLauncher: () => <div data-testid="launcher-stub" />
}))
vi.mock('@/components/editor/EditorPanel', () => ({
  EditorPanel: ({ filePath }: { filePath: string }) => (
    <div data-testid="editor-stub" data-filepath={filePath} />
  )
}))
vi.mock('@/components/terminal/ConnectedTerminal', async () => {
  const React = await import('react')
  return {
    ConnectedTerminal: ({
      storeTerminalId,
      isVisible
    }: {
      storeTerminalId: string
      isVisible: boolean
    }) => {
      React.useEffect(() => {
        probes.terminalMounts[storeTerminalId] = (probes.terminalMounts[storeTerminalId] ?? 0) + 1
      }, [storeTerminalId])
      probes.terminalVisible[storeTerminalId] = isVisible
      return <div data-testid={`terminal-${storeTerminalId}`} />
    }
  }
})
// Mirrors AgentChatPanel's gated transcript subscription (useAcpStoreVisible);
// the integration under test is that PaneContent hands a hidden project's chat
// `isVisible=false`.
vi.mock('@/components/chat/AgentChatPanel', async () => {
  const React = await import('react')
  const { useAcpStoreVisible } = await import('@/hooks/use-acp-visible-store')
  const EMPTY: never[] = []
  return {
    AgentChatPanel: ({
      sessionId,
      isVisible = true
    }: {
      sessionId: string
      isVisible?: boolean
    }) => {
      React.useEffect(() => {
        probes.chatMounts[sessionId] = (probes.chatMounts[sessionId] ?? 0) + 1
      }, [sessionId])
      probes.chatRenders[sessionId] = (probes.chatRenders[sessionId] ?? 0) + 1
      probes.chatVisible[sessionId] = isVisible
      const messages = useAcpStoreVisible((s) => s.messages[sessionId] ?? EMPTY, isVisible)
      probes.chatMessageCount[sessionId] = messages.length
      return <div data-testid={`chat-${sessionId}`}>{messages.length}</div>
    }
  }
})

import { ProjectTreeHost, useMountedProjectIds } from './ProjectTreeHost'

function leaf(id: string, tabs: LeafNode['tabs']): LeafNode {
  return { type: 'leaf', id, tabs, activeTabId: tabs[0]?.id ?? null }
}

function treeOf(root: LeafNode): ProjectWorkspace {
  return { ...createProjectWorkspace(), root, activePaneId: root.id }
}

function chatTree(project: string): ProjectWorkspace {
  return treeOf(
    leaf(`pane-${project}`, [
      { type: 'agent-chat', id: `chat-tab-${project}`, sessionId: `s-${project}` }
    ])
  )
}

function message(id: string): ChatMessage {
  return {
    id,
    role: 'agent',
    blocks: [{ type: 'text', text: id }],
    streaming: true,
    timestamp: 0
  } as ChatMessage
}

function Trees(): React.JSX.Element {
  const ids = useMountedProjectIds()
  const active = useWorkspaceStore((s) => s.activeProjectId)
  return (
    <div>
      {ids.map((id) => (
        <ProjectTreeHost key={id} projectId={id} isActiveProject={id === active} />
      ))}
    </div>
  )
}

function stateOf(projectId: string): string | null {
  return (
    document
      .querySelector(`[data-project-tree="${projectId}"]`)
      ?.getAttribute('data-project-tree-state') ?? null
  )
}

beforeEach(() => {
  for (const bag of Object.values(probes)) {
    for (const key of Object.keys(bag)) delete (bag as Record<string, unknown>)[key]
  }
  useWorkspaceStore.setState({ ...createProjectWorkspace(), activeProjectId: '', parkedTrees: {} })
  useTerminalStore.setState({ terminals: [] })
  useProjectStore.setState({ activeProjectId: 'A' })
  useAcpStore.setState({ messages: {} })
})

describe('ProjectTreeHost', () => {
  it('mounts the active and parked trees with only the active one visible', async () => {
    act(() => {
      useWorkspaceStore.getState().activateProject('A', chatTree('A'))
      useWorkspaceStore.getState().activateProject('B', chatTree('B'))
    })
    render(<Trees />)

    expect(await screen.findByTestId('chat-s-A')).toBeInTheDocument()
    expect(await screen.findByTestId('chat-s-B')).toBeInTheDocument()
    expect(stateOf('B')).toBe('active')
    expect(stateOf('A')).toBe('hidden')
    const hidden = document.querySelector('[data-project-tree="A"]')
    expect(hidden).toHaveAttribute('aria-hidden', 'true')
    expect(hidden).toHaveAttribute('inert')
    expect(document.querySelector('[data-project-tree="B"]')).not.toHaveAttribute('inert')
    expect(probes.chatVisible['s-B']).toBe(true)
    expect(probes.chatVisible['s-A']).toBe(false)
  })

  it('switching A -> B -> A keeps every tree mounted and keeps DOM order stable', async () => {
    act(() => useWorkspaceStore.getState().activateProject('A', chatTree('A')))
    render(<Trees />)
    await screen.findByTestId('chat-s-A')

    act(() => useWorkspaceStore.getState().activateProject('B', chatTree('B')))
    await screen.findByTestId('chat-s-B')
    const order = () =>
      [...document.querySelectorAll('[data-project-tree]')].map((el) =>
        el.getAttribute('data-project-tree')
      )
    expect(order()).toEqual(['A', 'B'])

    act(() => useWorkspaceStore.getState().activateProject('A'))
    expect(stateOf('A')).toBe('active')
    expect(stateOf('B')).toBe('hidden')
    expect(order()).toEqual(['A', 'B'])
    // Each chat panel mounted exactly once across the whole round trip.
    expect(probes.chatMounts).toEqual({ 's-A': 1, 's-B': 1 })
  })

  it('keeps a hidden terminal mounted but not visible, for its own project', async () => {
    useTerminalStore.setState({
      terminals: [
        { id: 'ta', projectId: 'A', ptyId: 'pty-a', name: 'a', shell: 'sh' },
        { id: 'tb', projectId: 'B', ptyId: 'pty-b', name: 'b', shell: 'sh' }
      ]
    })
    act(() => {
      useWorkspaceStore
        .getState()
        .activateProject(
          'A',
          treeOf(leaf('pane-A', [{ type: 'terminal', id: 'tab-ta', terminalId: 'ta' }]))
        )
      useWorkspaceStore
        .getState()
        .activateProject(
          'B',
          treeOf(leaf('pane-B', [{ type: 'terminal', id: 'tab-tb', terminalId: 'tb' }]))
        )
    })
    // The project store still says A is active (the coordinator commits both
    // together in the app); the hidden host must keep showing A's terminal.
    render(<Trees />)

    expect(await screen.findByTestId('terminal-ta')).toBeInTheDocument()
    expect(await screen.findByTestId('terminal-tb')).toBeInTheDocument()
    expect(probes.terminalVisible).toEqual({ ta: false, tb: true })

    act(() => useWorkspaceStore.getState().activateProject('A'))
    expect(probes.terminalVisible).toEqual({ ta: true, tb: false })
    expect(probes.terminalMounts).toEqual({ ta: 1, tb: 1 })
  })

  it('renders editor tabs and the launcher only while their project is on screen', async () => {
    act(() => {
      useWorkspaceStore
        .getState()
        .activateProject(
          'A',
          treeOf(leaf('pane-A', [{ type: 'editor', id: 'ed-a', filePath: '/a/file.ts' }]))
        )
      useWorkspaceStore.getState().activateProject('B', treeOf(leaf('pane-B', [])))
    })
    render(<Trees />)

    // B (active, empty pane) shows the launcher; A (hidden) shows neither the
    // editor (the editor store is swapped per project) nor a launcher.
    expect(await screen.findByTestId('launcher-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-stub')).toBeNull()

    act(() => useWorkspaceStore.getState().activateProject('A'))
    expect(await screen.findByTestId('editor-stub')).toHaveAttribute('data-filepath', '/a/file.ts')
    // The launcher leaves through an exit transition.
    await waitFor(() => expect(screen.queryByTestId('launcher-stub')).toBeNull())
  })

  it('drops a host when its project tree is dropped', async () => {
    act(() => {
      useWorkspaceStore.getState().activateProject('A', chatTree('A'))
      useWorkspaceStore.getState().activateProject('B', chatTree('B'))
    })
    render(<Trees />)
    await screen.findByTestId('chat-s-A')

    act(() => useWorkspaceStore.getState().dropProjectTree('A'))

    expect(screen.queryByTestId('chat-s-A')).toBeNull()
    expect(stateOf('B')).toBe('active')
  })
})

describe('ProjectTreeHost notify gating', () => {
  it('does not re-render a hidden chat when its session streams, and catches up on activation', async () => {
    act(() => {
      useWorkspaceStore.getState().activateProject('A', chatTree('A'))
      useWorkspaceStore.getState().activateProject('B', chatTree('B'))
    })
    render(<Trees />)
    await screen.findByTestId('chat-s-A')
    await screen.findByTestId('chat-s-B')

    const hiddenRendersBefore = probes.chatRenders['s-A']
    const visibleRendersBefore = probes.chatRenders['s-B']
    act(() => {
      for (let i = 0; i < 5; i++) {
        useAcpStore.setState((s) => ({
          messages: {
            ...s.messages,
            's-A': [...(s.messages['s-A'] ?? []), message(`a${i}`)],
            's-B': [...(s.messages['s-B'] ?? []), message(`b${i}`)]
          }
        }))
      }
    })

    // The visible project's chat renders its stream; the hidden one pays nothing.
    expect(probes.chatRenders['s-A']).toBe(hiddenRendersBefore)
    expect(probes.chatMessageCount['s-A']).toBe(0)
    expect(probes.chatMessageCount['s-B']).toBe(5)
    expect(probes.chatRenders['s-B']).toBeGreaterThan(visibleRendersBefore)

    // Becoming active catches up on everything streamed meanwhile, in one go.
    act(() => useWorkspaceStore.getState().activateProject('A'))
    expect(probes.chatMessageCount['s-A']).toBe(5)
    expect(screen.getByTestId('chat-s-A')).toHaveTextContent('5')
  })

  it('does not re-render a hidden host for active-tree changes', async () => {
    act(() => {
      useWorkspaceStore.getState().activateProject('A', chatTree('A'))
      useWorkspaceStore.getState().activateProject('B', chatTree('B'))
    })
    render(<Trees />)
    await screen.findByTestId('chat-s-A')

    const before = probes.chatRenders['s-A']
    act(() => {
      // Active-tree churn: focus, launcher and a new tab all notify the store.
      useWorkspaceStore.getState().showAgentLauncher('pane-B')
      useWorkspaceStore.getState().hideAgentLauncher()
      useWorkspaceStore.getState().setActivePane('pane-B')
      useWorkspaceStore.getState().addEditorTab('/b/new.ts')
    })

    expect(probes.chatRenders['s-A']).toBe(before)
  })
})
