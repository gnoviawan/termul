import type { Dispatch, SetStateAction } from 'react'
import { Keyboard, RotateCcw } from '@/components/icons'
import { ShortcutRecorder } from '@/components/ShortcutRecorder'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { KeyboardShortcutsConfig } from '@/types/settings'

/**
 * Shortcut ids that are desktop-only (issue #843): hidden from the web
 * preferences list instead of shown as unbindable entries.
 */
const DESKTOP_ONLY_SHORTCUT_IDS: Record<string, true> = { newBrowserTab: true }

interface ShortcutsSectionProps {
  shortcuts: KeyboardShortcutsConfig
  updateShortcut: (id: string, customKey: string) => void
  resetShortcut: (id: string) => void
  setIsResetShortcutsDialogOpen: Dispatch<SetStateAction<boolean>>
}

export function ShortcutsSection({
  shortcuts,
  updateShortcut,
  resetShortcut,
  setIsResetShortcutsDialogOpen
}: ShortcutsSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="shortcuts">
      <div className="grid grid-cols-1 items-start gap-6 border-b border-border pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="w-full pt-1">
          <div className="flex items-center gap-2">
            <Keyboard size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">Keyboard Shortcuts</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Customize keyboard shortcuts to match your workflow.
          </p>
          <button
            onClick={() => setIsResetShortcutsDialogOpen(true)}
            className="mt-4 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RotateCcw size={12} />
            Reset all shortcuts
          </button>
        </div>
        <div className="w-full space-y-4">
          {Object.values(shortcuts)
            .filter((shortcut) => isTauriContext() || !DESKTOP_ONLY_SHORTCUT_IDS[shortcut.id])
            .map((shortcut) => (
              <ShortcutRecorder
                key={shortcut.id}
                shortcut={shortcut}
                allShortcuts={shortcuts}
                onUpdate={updateShortcut}
                onReset={resetShortcut}
              />
            ))}
        </div>
      </div>
    </SettingsSection>
  )
}
