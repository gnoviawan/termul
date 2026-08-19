import { toast } from 'sonner'
import { runtimeT } from '@/i18n/runtime'
import { useEditorStore } from '@/stores/editor-store'
import { matchesShortcut, useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'

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
      toast.success(runtimeT('workspace', 'tabs.saved', '{{name}} saved', { name: fileName }))
    } else {
      toast.error(
        runtimeT('workspace', 'tabs.saveFailed', 'Failed to save {{name}}', { name: fileName })
      )
    }
    return saved
  } catch {
    toast.error(
      runtimeT('workspace', 'tabs.saveFailed', 'Failed to save {{name}}', { name: fileName })
    )
    return false
  }
}
