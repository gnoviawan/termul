import { closeAgentChat } from '@/lib/agent-chat-close'
import {
  isWorkspaceTabKind,
  reportUnknownTabKind,
  type WorkspaceTabKind
} from '@/lib/workspace-tab-kinds'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'

type TabOfKind<K extends WorkspaceTabKind> = Extract<WorkspaceTab, { type: K }>

type OpenedConfirm = boolean

export interface GuardedTabClose {
  terminal: (tab: TabOfKind<'terminal'>) => OpenedConfirm
  editor: (tab: TabOfKind<'editor'>) => OpenedConfirm
}

type TabCloser<K extends WorkspaceTabKind> = (
  tab: TabOfKind<K>,
  guarded: GuardedTabClose
) => OpenedConfirm

function removeTab(tab: WorkspaceTab): OpenedConfirm {
  useWorkspaceStore.getState().removeTab(tab.id)
  return false
}

const TAB_CLOSE: { [K in WorkspaceTabKind]: TabCloser<K> } = {
  terminal: (tab, guarded) => guarded.terminal(tab),
  editor: (tab, guarded) => guarded.editor(tab),
  browser: (tab) => {
    useBrowserSessionStore.getState().removeTab(tab.browserTabId)
    return removeTab(tab)
  },
  git: removeTab,
  'git-history': removeTab,
  diff: removeTab,
  'commit-diff': removeTab,
  'agent-chat': (tab) => {
    closeAgentChat(tab.sessionId, () => {
      useWorkspaceStore.getState().removeTab(tab.id)
    })
    return false
  },
  canvas: (tab) => {
    void useCanvasStore.getState().closeCanvas(tab.projectId)
    return removeTab(tab)
  }
}

export function closeWorkspaceTab(
  tab: WorkspaceTab,
  guarded: GuardedTabClose,
  logSource: string
): OpenedConfirm {
  if (!isWorkspaceTabKind(tab.type)) {
    reportUnknownTabKind(tab as never, logSource, 'closed without teardown')
    return removeTab(tab)
  }
  const close = TAB_CLOSE[tab.type] as TabCloser<WorkspaceTabKind>
  return close(tab, guarded)
}
