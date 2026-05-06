import { create } from 'zustand'

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  annotationMode: boolean
}

export interface BrowserSessionState {
  tabs: Map<string, BrowserTab>

  // Actions
  createTab: (id: string, url?: string) => BrowserTab
  removeTab: (id: string) => void
  updateUrl: (id: string, url: string) => void
  updateTitle: (id: string, title: string) => void
  setLoading: (id: string, loading: boolean) => void
  setNavCapabilities: (id: string, canGoBack: boolean, canGoForward: boolean) => void
  setAnnotationMode: (id: string, enabled: boolean) => void
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
      canGoForward: false,
      annotationMode: false,
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
      const tab = state.tabs.get(id)
      if (!tab) return state
      const next = new Map(state.tabs)
      next.set(id, { ...tab, url })
      return { tabs: next }
    })
  },

  updateTitle: (id: string, title: string) => {
    set((state) => {
      const tab = state.tabs.get(id)
      if (!tab) return state
      const next = new Map(state.tabs)
      next.set(id, { ...tab, title })
      return { tabs: next }
    })
  },

  setLoading: (id: string, loading: boolean) => {
    set((state) => {
      const tab = state.tabs.get(id)
      if (!tab) return state
      const next = new Map(state.tabs)
      next.set(id, { ...tab, loading })
      return { tabs: next }
    })
  },

  setNavCapabilities: (id: string, canGoBack: boolean, canGoForward: boolean) => {
    set((state) => {
      const tab = state.tabs.get(id)
      if (!tab) return state
      const next = new Map(state.tabs)
      next.set(id, { ...tab, canGoBack, canGoForward })
      return { tabs: next }
    })
  },

  setAnnotationMode: (id: string, enabled: boolean) => {
    set((state) => {
      const tab = state.tabs.get(id)
      if (!tab) return state
      const next = new Map(state.tabs)
      next.set(id, { ...tab, annotationMode: enabled })
      return { tabs: next }
    })
  },

  getTab: (id: string) => {
    return get().tabs.get(id)
  },
}))
