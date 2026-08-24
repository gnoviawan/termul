import { create } from 'zustand'

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserSessionState {
  tabs: Map<string, BrowserTab>

  createTab: (id: string, url?: string) => BrowserTab
  removeTab: (id: string) => void
  updateUrl: (id: string, url: string) => void
  updateTitle: (id: string, title: string) => void
  setLoading: (id: string, loading: boolean) => void
  setNavCapabilities: (id: string, canGoBack: boolean, canGoForward: boolean) => void
  ensureTab: (id: string, url: string) => BrowserTab
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

  updateTitle: (id: string, title: string) => {
    set((state) => {
      const next = new Map(state.tabs)
      const t = next.get(id)
      if (t) next.set(id, { ...t, title })
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

  ensureTab: (id: string, url: string) => {
    const existing = get().tabs.get(id)
    if (existing) return existing
    return get().createTab(id, url)
  },

  getTab: (id: string) => get().tabs.get(id)
}))
