import { chatForeignToProject as chatForeignToProjectIn } from '@/lib/acp-session-ownership'
import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'
import { useAcpStore } from '@/stores/acp-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { browserTabId, editorTabId, terminalTabId } from '@/stores/workspace-store'
import type { Terminal } from '@/types/project'
import type { PaneNode, SplitNode } from '@/types/workspace.types'
import type { PersistedTerminalLayout } from '../../../shared/types/persistence.types'
import type { PersistedPaneNode, PersistedPaneNodeInput, PersistedTabRef } from './types'

// Serialize pane tree for persistence with both editor and terminal tabs.
// `options.agentChatOwnedBy` (when provided) drops agent-chat tabs the
// predicate rejects — the per-project persistence filter (see persistState).
interface SerializePaneTreeOptions {
  agentChatOwnedBy?: (sessionId: string) => boolean
}

export function serializePaneTree(
  node: PaneNode,
  options?: SerializePaneTreeOptions
): PersistedPaneNode {
  if (node.type === 'leaf') {
    const tabs: PersistedTabRef[] = node.tabs.flatMap((tab): PersistedTabRef[] => {
      if (tab.type === 'editor') {
        return [{ type: 'editor', filePath: tab.filePath }]
      }

      if (tab.type === 'terminal') {
        return [{ type: 'terminal', terminalId: tab.terminalId }]
      }

      if (tab.type === 'browser') {
        const browserTab = useBrowserSessionStore.getState().tabs.get(tab.browserTabId)
        return [{ type: 'browser', browserTabId: tab.browserTabId, url: browserTab?.url }]
      }

      if (tab.type === 'git') {
        return [{ type: 'git', id: tab.id, cwd: tab.cwd }]
      }

      if (tab.type === 'agent-chat') {
        // The session itself is persisted separately (P5 history); we persist
        // the tab so the pane reappears on restart. The chat shows its closed/
        // empty state until reopened from history. An ownership predicate
        // (persistState) drops other projects' chats — the global tree can
        // carry them mid-switch, and persisting them would seed cross-project
        // tab leaks on restore.
        if (options?.agentChatOwnedBy && !options.agentChatOwnedBy(tab.sessionId)) {
          return []
        }
        return [{ type: 'agent-chat', id: tab.id, sessionId: tab.sessionId }]
      }

      if (tab.type === 'git-history') {
        return [{ type: 'git-history', id: tab.id, cwd: tab.cwd }]
      }

      return []
    })

    return {
      type: 'leaf',
      id: node.id,
      tabs,
      activeTabId: node.activeTabId
    }
  }

  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: node.children.map((child) => serializePaneTree(child, options)),
    sizes: node.sizes
  }
}

function sanitizePaneNode(node: PaneNode): PaneNode | null {
  if (node.type === 'leaf') {
    return node
  }

  // Track original indices to correctly map sizes after filtering
  const survivingEntries = node.children
    .map((child, originalIndex) => ({
      child: sanitizePaneNode(child),
      originalIndex
    }))
    .filter((entry): entry is { child: PaneNode; originalIndex: number } => entry.child !== null)

  if (survivingEntries.length === 0) {
    return null
  }

  if (survivingEntries.length === 1) {
    return survivingEntries[0].child
  }

  const rawSizes = node.sizes
  const validSizes = survivingEntries.map((entry) => {
    const value = rawSizes[entry.originalIndex]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
  })
  const total = validSizes.reduce((sum, value) => sum + value, 0)

  return {
    ...node,
    children: survivingEntries.map((entry) => entry.child),
    sizes: validSizes.map((value) => (value / total) * 100)
  }
}

function normalizePaneTree(root: PaneNode): PaneNode {
  const normalized = sanitizePaneNode(root)
  if (normalized) {
    return normalized
  }

  return {
    type: 'leaf',
    id: randomUUID(),
    tabs: [],
    activeTabId: null
  }
}

function createTerminalMatcher(
  liveTerminals: Terminal[],
  layout: PersistedTerminalLayout | null
): {
  hasLiveTerminals: boolean
  matchTerminalId: (persistedTerminalId: string) => string | null
} {
  const liveTerminalsById = new Map(liveTerminals.map((terminal) => [terminal.id, terminal]))
  const layoutTerminalsById = new Map(
    layout?.terminals.map((terminal) => [terminal.id, terminal]) ?? []
  )
  const unusedLiveTerminals = [...liveTerminals]

  const consumeLiveTerminal = (terminalId: string): string | null => {
    const match = liveTerminalsById.get(terminalId)
    if (!match) {
      return null
    }

    const index = unusedLiveTerminals.findIndex((terminal) => terminal.id === terminalId)
    if (index >= 0) {
      unusedLiveTerminals.splice(index, 1)
    }
    return match.id
  }

  return {
    hasLiveTerminals: liveTerminals.length > 0,
    matchTerminalId: (persistedTerminalId: string): string | null => {
      const directMatch = consumeLiveTerminal(persistedTerminalId)
      if (directMatch) {
        return directMatch
      }

      const persistedTerminal = layoutTerminalsById.get(persistedTerminalId)
      if (!persistedTerminal) {
        return null
      }

      const exactIndex = unusedLiveTerminals.findIndex((terminal) => {
        return (
          terminal.name === persistedTerminal.name &&
          terminal.shell === persistedTerminal.shell &&
          terminal.cwd === persistedTerminal.cwd
        )
      })
      if (exactIndex >= 0) {
        const [match] = unusedLiveTerminals.splice(exactIndex, 1)
        return match.id
      }

      const nameAndShellIndex = unusedLiveTerminals.findIndex((terminal) => {
        return (
          terminal.name === persistedTerminal.name && terminal.shell === persistedTerminal.shell
        )
      })
      if (nameAndShellIndex >= 0) {
        const [match] = unusedLiveTerminals.splice(nameAndShellIndex, 1)
        return match.id
      }

      const nameOnlyIndex = unusedLiveTerminals.findIndex(
        (terminal) => terminal.name === persistedTerminal.name
      )
      if (nameOnlyIndex >= 0) {
        const [match] = unusedLiveTerminals.splice(nameOnlyIndex, 1)
        return match.id
      }

      return null
    }
  }
}

export function reconcileTerminalTabs(
  root: PaneNode,
  openFilePaths: Set<string>,
  liveTerminals: Terminal[],
  layout: PersistedTerminalLayout | null
): PaneNode {
  const { hasLiveTerminals, matchTerminalId } = createTerminalMatcher(liveTerminals, layout)
  const shouldKeepPersistedTerminalTabs = !hasLiveTerminals && !!layout?.terminals.length

  const visit = (node: PaneNode): PaneNode => {
    if (node.type === 'leaf') {
      const terminalTabIdMap = new Map<string, string>()
      const validTabs = node.tabs.flatMap((tab): WorkspaceTab[] => {
        if (tab.type === 'editor') {
          return openFilePaths.has(tab.filePath) ? [tab] : []
        }

        if (tab.type === 'browser') {
          return [tab]
        }

        if (tab.type === 'git') {
          return [tab]
        }

        if (tab.type === 'agent-chat') {
          return [tab]
        }

        if (tab.type === 'git-history') {
          return [tab]
        }

        // Canvas tabs: the daemon/iframe runtime is host-local state, never
        // portable across a restore — dropped here like every other
        // non-portable tab body; the canvas re-opens user-initiated.
        if (tab.type === 'canvas') {
          return []
        }

        if (shouldKeepPersistedTerminalTabs) {
          return [tab]
        }

        const mappedTerminalId = matchTerminalId(tab.terminalId)
        if (!mappedTerminalId) {
          return []
        }

        const mappedTabId = terminalTabId(mappedTerminalId)
        terminalTabIdMap.set(tab.id, mappedTabId)

        return [
          {
            type: 'terminal',
            id: mappedTabId,
            terminalId: mappedTerminalId
          }
        ]
      })

      let activeTabId = node.activeTabId
      if (activeTabId && terminalTabIdMap.has(activeTabId)) {
        activeTabId = terminalTabIdMap.get(activeTabId) ?? activeTabId
      }
      if (activeTabId && !validTabs.some((tab) => tab.id === activeTabId)) {
        activeTabId = validTabs.length > 0 ? validTabs[0].id : null
      }

      return {
        ...node,
        tabs: validTabs,
        activeTabId
      }
    }

    return {
      ...node,
      children: node.children.map(visit)
    } as SplitNode
  }

  return normalizePaneTree(visit(root))
}

// Deserialize pane tree with full tab mapping
// `projectId` (when given) drops agent-chat tabs KNOWN to belong to another
// project — a layout saved while a foreign chat leaked into the shared pane
// tree would otherwise re-render that chat on this project.
export function deserializePaneTree(persisted: PersistedPaneNodeInput, projectId = ''): PaneNode {
  if (persisted.type === 'leaf') {
    const tabs: WorkspaceTab[] = ('tabs' in persisted ? persisted.tabs : []).flatMap(
      (tab): WorkspaceTab[] => {
        if (tab.type === 'editor') {
          return [
            {
              type: 'editor',
              id: editorTabId(tab.filePath),
              filePath: tab.filePath
            }
          ]
        }

        if (tab.type === 'browser') {
          const bTabId = browserTabId(tab.browserTabId)
          // Restore browser session entry lazily
          useBrowserSessionStore.getState().createTab(tab.browserTabId, tab.url)
          return [
            {
              type: 'browser',
              id: bTabId,
              browserTabId: tab.browserTabId
            }
          ]
        }

        if (tab.type === 'git') {
          return [
            {
              type: 'git',
              id: tab.id,
              cwd: tab.cwd
            }
          ]
        }

        if (tab.type === 'agent-chat') {
          // Drop `launch-*` placeholder tabs: a successful launch always remaps
          // the tab to the real session id, so a persisted launch-* tab is
          // always a corpse from a failed launch (restoring it would render the
          // "chat unavailable" fallback with nothing to retry). Also tolerate
          // corrupt/legacy entries missing a sessionId — drop just that tab
          // instead of aborting the whole restore.
          if (typeof tab.sessionId !== 'string' || tab.sessionId.startsWith('launch-')) {
            // Durable boundary log: a pruned tab is otherwise invisible.
            void logFrontendError({
              level: 'warn',
              source: 'useEditorPersistence.deserializePaneTree',
              message:
                typeof tab.sessionId === 'string'
                  ? `Dropped failed-launch placeholder chat tab (session ${tab.sessionId}) during workspace restore`
                  : 'Dropped agent-chat tab with a missing/invalid sessionId during workspace restore'
            })
            return []
          }
          if (chatForeignToProject(tab.sessionId, projectId)) {
            void logFrontendError({
              level: 'warn',
              source: 'useEditorPersistence.deserializePaneTree',
              message: `Dropped foreign-project chat tab (session ${tab.sessionId}) during workspace restore for project ${projectId}`
            })
            return []
          }
          return [
            {
              type: 'agent-chat',
              id: tab.id,
              sessionId: tab.sessionId
            }
          ]
        }

        if (tab.type === 'git-history') {
          return [
            {
              type: 'git-history',
              id: tab.id,
              cwd: tab.cwd
            }
          ]
        }

        return [
          {
            type: 'terminal',
            id: terminalTabId(tab.terminalId),
            terminalId: tab.terminalId
          }
        ]
      }
    )

    // Backward-compatibility fallback for legacy pre-release shape.
    if (tabs.length === 0 && 'editorFilePaths' in persisted) {
      persisted.editorFilePaths.forEach((filePath) => {
        tabs.push({
          type: 'editor',
          id: editorTabId(filePath),
          filePath
        })
      })
    }

    // A dropped tab (e.g. a `launch-*` placeholder corpse) can leave the
    // persisted activeTabId dangling — fall back to the first surviving tab.
    const activeTabId =
      persisted.activeTabId && tabs.some((t) => t.id === persisted.activeTabId)
        ? persisted.activeTabId
        : (tabs[0]?.id ?? null)

    return {
      type: 'leaf',
      id: persisted.id,
      tabs,
      activeTabId
    }
  }

  return {
    type: 'split',
    id: persisted.id,
    direction: persisted.direction,
    children: persisted.children.map((child) => deserializePaneTree(child, projectId)),
    sizes: persisted.sizes
  }
}

/**
 * Whether an agent-chat session belongs to a project other than `projectId`
 * — FAIL-OPEN (see `lib/acp-session-ownership`): an id with NO ownership data
 * anywhere (index not yet loaded on a fresh mount, a session the host has
 * never seen) is kept; only sessions the store/index attribute to a
 * DIFFERENT project are filtered out. Fail-open preserves the
 * restore-before-index-load contract (reattach must not drop tabs it cannot
 * yet judge) while still cutting every known foreign session.
 */
export function chatForeignToProject(sessionId: string, projectId: string): boolean {
  return chatForeignToProjectIn(sessionId, projectId, useAcpStore.getState())
}
