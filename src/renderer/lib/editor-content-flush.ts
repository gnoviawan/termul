export type EditorContentFlusher = () => void | Promise<void>

const flushersByPath = new Map<string, EditorContentFlusher>()

export function registerEditorContentFlusher(path: string, flush: EditorContentFlusher): void {
  flushersByPath.set(path, flush)
}

export function unregisterEditorContentFlusher(path: string): void {
  flushersByPath.delete(path)
}

/** Sync live editor buffer into the store before read-only save paths run. */
export async function flushEditorContent(path: string): Promise<void> {
  const flush = flushersByPath.get(path)
  if (!flush) return
  await flush()
}
