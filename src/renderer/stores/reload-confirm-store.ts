/**
 * The open "Reload this chat?" confirm. A reload starts a new agent process,
 * so it stops the background agents of the old one. The reload controls (tab
 * menu, composer menu, phone header) ask here first, and the chat panel of
 * the session shows the confirm.
 */

import { create } from 'zustand'
import type { SessionId } from '@/lib/acp-api'

export interface ReloadConfirmRequest {
  sessionId: SessionId
  backgroundAgents: number
}

interface ReloadConfirmState {
  request: ReloadConfirmRequest | null
  ask: (request: ReloadConfirmRequest) => void
  clear: () => void
}

export const useReloadConfirmStore = create<ReloadConfirmState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  clear: () => set({ request: null })
}))
