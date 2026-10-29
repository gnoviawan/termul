import { create } from 'zustand'
import type { BrowserTabView } from '@/lib/browser-api'

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** True for a tab an ACP session drives via the `browser` tool. Shows
   *  the Agent badge; closing the tab revokes control host-side. */
  agentControlled?: boolean
}

export interface BrowserSessionState {
  tabs: Map<string, BrowserTab>

  createTab: (id: string, url?: string) => BrowserTab
  removeTab: (id: string) => void
  /** The URL the user asked for; the tab's webview follows it. */
  updateUrl: (id: string, url: string) => void
  /** Mirror the host registry's view of a tab. */
  applyView: (view: BrowserTabView) => void
  setLoading: (id: string, loading: boolean) => void
  setNavCapabilities: (id: string, canGoBack: boolean, canGoForward: boolean) => void
  setAgentControlled: (id: string, controlled: boolean) => void
  getTab: (id: string) => BrowserTab | undefined
}

const DEFAULT_BROWSER_URL = 'https://www.google.com'

export const useBrowserSessionStore = create<BrowserSessionState>((set, get) => ({
  tabs: new Map(),

  createTab: (id: string, url: string = DEFAULT_BROWSER_URL) => {
    const tab: BrowserTab = {
      id,
      url,
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false
    }
    set((state) => {
      const next = new Map(state.tabs)
      next.set(id, tab)
      return { tabs: next }
    })
    return tab
  },

  removeTab: (id: string) => {
    set((state) => {
      const next = new Map(state.tabs)
      next.delete(id)
      return { tabs: next }
    })
  },

  updateUrl: (id: string, url: string) => {
    set((state) => {
      const next = new Map(state.tabs)
      const t = next.get(id)
      if (t) next.set(id, { ...t, url })
      return { tabs: next }
    })
  },

  applyView: (view: BrowserTabView) => {
    set((state) => {
      const t = state.tabs.get(view.tabId)
      if (!t) return state
      const next = new Map(state.tabs)
      next.set(view.tabId, {
        ...t,
        url: view.url,
        title: view.title,
        loading: view.loading,
        agentControlled: view.agentControlled
      })
      return { tabs: next }
    })
  },

  setLoading: (id: string, loading: boolean) => {
    set((state) => {
      const next = new Map(state.tabs)
      const t = next.get(id)
      if (t) next.set(id, { ...t, loading })
      return { tabs: next }
    })
  },

  setNavCapabilities: (id: string, canGoBack: boolean, canGoForward: boolean) => {
    set((state) => {
      const next = new Map(state.tabs)
      const t = next.get(id)
      if (t) next.set(id, { ...t, canGoBack, canGoForward })
      return { tabs: next }
    })
  },

  setAgentControlled: (id: string, controlled: boolean) => {
    set((state) => {
      const next = new Map(state.tabs)
      const t = next.get(id)
      if (t) next.set(id, { ...t, agentControlled: controlled })
      return { tabs: next }
    })
  },

  getTab: (id: string) => get().tabs.get(id)
}))
