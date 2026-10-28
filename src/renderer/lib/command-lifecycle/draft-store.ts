import type { InputMode } from './transition'

export function createCommandDraftStore() {
  const drafts = new Map<string, string>()
  return {
    read(id: string): string {
      return drafts.get(id) ?? ''
    },
    submitAccepted(id: string) {
      drafts.delete(id)
    },
    processExited(id: string) {
      drafts.delete(id)
    },
    offer(id: string, mode: InputMode, text: string) {
      if (mode === 'Editor') drafts.set(id, text)
    }
  }
}

export const commandDraftStore = createCommandDraftStore()
