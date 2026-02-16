import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'

export type WorkspaceTab =
  | { type: 'terminal'; id: string; terminalId: string }
  | { type: 'editor'; id: string; filePath: string }

export interface WorkspaceState {
  tabs: WorkspaceTab[]
  activeTabId: string | null

  addTerminalTab: (terminalId: string) => void
  addEditorTab: (filePath: string) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
  reorderTabs: (orderedIds: string[]) => void
  getActiveTab: () => WorkspaceTab | undefined
  syncTerminalTabs: (terminalIds: string[]) => void
  getNextTabId: (direction: 1 | -1) => string | null
}

function terminalTabId(terminalId: string): string {
  return 'term-' + terminalId
}

function editorTabId(filePath: string): string {
  return 'edit-' + filePath
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTerminalTab: (terminalId: string): void => {
    const id = terminalTabId(terminalId)
    const { tabs } = get()

    // No-op if already exists
    if (tabs.some((t) => t.id === id)) return

    const tab: WorkspaceTab = { type: 'terminal', id, terminalId }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  addEditorTab: (filePath: string): void => {
    const id = editorTabId(filePath)
    const { tabs } = get()

    // No-op if already exists
    if (tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
      return
    }

    const tab: WorkspaceTab = { type: 'editor', id, filePath }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  removeTab: (id: string): void => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.id === id)
    if (index === -1) return

    const newTabs = tabs.filter((t) => t.id !== id)

    let newActive = activeTabId
    if (activeTabId === id) {
      if (newTabs.length > 0) {
        // Select the tab at the same index, or the last one
        const newIndex = Math.min(index, newTabs.length - 1)
        newActive = newTabs[newIndex].id
      } else {
        newActive = null
      }
    }

    set({ tabs: newTabs, activeTabId: newActive })
  },

  setActiveTab: (id: string): void => {
    set({ activeTabId: id })
  },

  reorderTabs: (orderedIds: string[]): void => {
    const { tabs } = get()
    const tabMap = new Map<string, WorkspaceTab>()
    tabs.forEach((t) => tabMap.set(t.id, t))

    const reordered = orderedIds
      .map((id) => tabMap.get(id))
      .filter((t): t is WorkspaceTab => t !== undefined)

    set({ tabs: reordered })
  },

  getActiveTab: (): WorkspaceTab | undefined => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId)
  },

  syncTerminalTabs: (terminalIds: string[]): void => {
    const { tabs } = get()
    const terminalTabIds = new Set(terminalIds.map(terminalTabId))

    // Remove orphaned terminal tabs
    const newTabs = tabs.filter((t) => {
      if (t.type === 'terminal') {
        return terminalTabIds.has(t.id)
      }
      return true
    })

    // Add missing terminal tabs
    const existingTerminalIds = new Set(
      newTabs.filter((t) => t.type === 'terminal').map((t) => t.id)
    )

    for (const terminalId of terminalIds) {
      const id = terminalTabId(terminalId)
      if (!existingTerminalIds.has(id)) {
        newTabs.push({ type: 'terminal', id, terminalId })
      }
    }

    // Fix active tab if orphaned
    const { activeTabId } = get()
    let newActive = activeTabId
    if (activeTabId && !newTabs.some((t) => t.id === activeTabId)) {
      newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
    }

    set({ tabs: newTabs, activeTabId: newActive })
  },

  getNextTabId: (direction: 1 | -1): string | null => {
    const { tabs, activeTabId } = get()
    if (tabs.length === 0) return null
    if (!activeTabId) return tabs[0].id

    const currentIndex = tabs.findIndex((t) => t.id === activeTabId)
    if (currentIndex === -1) return tabs[0].id

    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
    return tabs[nextIndex].id
  }
}))

// Selector hooks
export function useWorkspaceTabs(): WorkspaceTab[] {
  return useWorkspaceStore(useShallow((state) => state.tabs))
}

export function useActiveTab(): WorkspaceTab | undefined {
  return useWorkspaceStore((state) =>
    state.tabs.find((t) => t.id === state.activeTabId)
  )
}

export function useActiveTabId(): string | null {
  return useWorkspaceStore((state) => state.activeTabId)
}

export function useWorkspaceActions(): Pick<
  WorkspaceState,
  | 'addTerminalTab'
  | 'addEditorTab'
  | 'removeTab'
  | 'setActiveTab'
  | 'reorderTabs'
  | 'syncTerminalTabs'
  | 'getNextTabId'
> {
  return useWorkspaceStore(
    useShallow((state) => ({
      addTerminalTab: state.addTerminalTab,
      addEditorTab: state.addEditorTab,
      removeTab: state.removeTab,
      setActiveTab: state.setActiveTab,
      reorderTabs: state.reorderTabs,
      syncTerminalTabs: state.syncTerminalTabs,
      getNextTabId: state.getNextTabId
    }))
  )
}

export { terminalTabId, editorTabId }
