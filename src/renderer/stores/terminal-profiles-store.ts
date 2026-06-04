import { create } from 'zustand'
import type { TerminalProfile } from '@/types/terminal-profile'
import { DEFAULT_TERMINAL_PROFILES } from '@/types/terminal-profile'

interface TerminalProfilesState {
  profiles: TerminalProfile[]
  isLoaded: boolean
  setProfiles: (profiles: TerminalProfile[]) => void
  addProfile: (profile: Omit<TerminalProfile, 'id' | 'createdAt' | 'updatedAt'>) => TerminalProfile
  updateProfile: (id: string, updates: Partial<Omit<TerminalProfile, 'id' | 'createdAt'>>) => void
  deleteProfile: (id: string) => void
  getProfile: (id: string) => TerminalProfile | undefined
}

export const useTerminalProfilesStore = create<TerminalProfilesState>((set, get) => ({
  profiles: DEFAULT_TERMINAL_PROFILES,
  isLoaded: false,

  setProfiles: (profiles) => set({ profiles, isLoaded: true }),

  addProfile: (profileData) => {
    const now = Date.now()
    const newProfile: TerminalProfile = {
      ...profileData,
      id: now.toString(),
      createdAt: now,
      updatedAt: now
    }
    set((state) => ({
      profiles: [...state.profiles, newProfile]
    }))
    return newProfile
  },

  updateProfile: (id, updates) => {
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
      )
    }))
  },

  deleteProfile: (id) => {
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id)
    }))
  },

  getProfile: (id) => {
    return get().profiles.find((p) => p.id === id)
  }
}))

// Selectors
export const useTerminalProfiles = () => useTerminalProfilesStore((state) => state.profiles)
export const useTerminalProfilesLoaded = () => useTerminalProfilesStore((state) => state.isLoaded)
export const useTerminalProfile = (id: string) =>
  useTerminalProfilesStore((state) => state.profiles.find((p) => p.id === id))
