import { toast } from 'sonner'
import { useEditorStore } from '@/stores/editor-store'
import { useKeyboardShortcutsStore, matchesShortcut } from '@/stores/keyboard-shortcuts-store'

export function getEditorFileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

export function getSaveFileShortcutKey(): string {
  const shortcut = useKeyboardShortcutsStore.getState().shortcuts.saveFile
  return shortcut?.customKey ?? shortcut?.defaultKey ?? 'ctrl+s'
}

export function isSaveFileShortcut(event: KeyboardEvent): boolean {
  return matchesShortcut(event, getSaveFileShortcutKey())
}

/** Flush live editor buffer (if mounted) and persist the file. */
export async function requestSaveEditorFile(filePath: string): Promise<boolean> {
  const fileName = getEditorFileBaseName(filePath)
  try {
    const saved = await useEditorStore.getState().saveFile(filePath)
    if (saved) {
      toast.success(`${fileName} saved`)
    } else {
      toast.error(`Failed to save ${fileName}`)
    }
    return saved
  } catch {
    toast.error(`Failed to save ${fileName}`)
    return false
  }
}
