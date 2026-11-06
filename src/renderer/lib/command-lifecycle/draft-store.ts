import type { InputMode } from './transition'

export function createCommandDraftStore() {
  const drafts = new Map<string, string>()
  const invalidationVersions = new Map<string, number>()
  const invalidate = (id: string) => {
    drafts.delete(id)
    invalidationVersions.set(id, (invalidationVersions.get(id) ?? 0) + 1)
  }
  return {
    invalidationVersion(id: string): number {
      return invalidationVersions.get(id) ?? 0
    },
    read(id: string): string {
      return drafts.get(id) ?? ''
    },
    submitAccepted(id: string) {
      invalidate(id)
    },
    processExited(id: string) {
      invalidate(id)
    },
    offer(id: string, mode: InputMode, text: string) {
      if (mode === 'Editor') drafts.set(id, text)
    }
  }
}

export const commandDraftStore = createCommandDraftStore()
