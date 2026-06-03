const SELF_SAVE_GRACE_MS = 3000
const selfSavedAtByPath = new Map<string, number>()

export function markEditorSelfSave(filePath: string): void {
  selfSavedAtByPath.set(filePath, Date.now())
}

/** True when the file change event is from our own save (consume one-shot). */
export function consumeEditorSelfSave(filePath: string): boolean {
  const savedAt = selfSavedAtByPath.get(filePath)
  if (savedAt === undefined) return false
  selfSavedAtByPath.delete(filePath)
  return Date.now() - savedAt <= SELF_SAVE_GRACE_MS
}
