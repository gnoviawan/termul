import { Keyboard } from 'lucide-react'
import { toast } from 'sonner'
import { ShortcutRecorder } from '@/components/ShortcutRecorder'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover'
import {
  useResetShortcut,
  useUpdateShortcut
} from '@/hooks/use-keyboard-shortcuts'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import type { KeyboardShortcut } from '@/types/settings'

const QUICK_SHORTCUT_IDS = [
  'commandPalette',
  'commandHistory',
  'newTerminal',
  'newBrowserTab',
  'toggleFileExplorer',
  'sidebarToggle',
  'zoomIn',
  'zoomOut',
  'zoomReset'
] as const

interface TitleBarShortcutsPopoverProps {
  buttonClassName: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function TitleBarShortcutsPopover({
  buttonClassName,
  open,
  onOpenChange
}: TitleBarShortcutsPopoverProps): React.JSX.Element {
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const updateShortcut = useUpdateShortcut()
  const resetShortcut = useResetShortcut()

  const quickShortcuts = QUICK_SHORTCUT_IDS.map((id) => shortcuts[id]).filter(
    (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut)
  )

  const handleUpdate = (id: string, customKey: string): void => {
    void updateShortcut(id, customKey).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save shortcut')
    })
  }

  const handleReset = (id: string): void => {
    void resetShortcut(id).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to reset shortcut')
    })
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={buttonClassName}
          title="Keyboard shortcuts"
          aria-label="Open keyboard shortcuts menu"
          aria-expanded={open}
        >
          <Keyboard size={16} className="text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="z-[120] w-[360px] max-w-[calc(100vw-1rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Keyboard aria-hidden="true" size={15} />
            Shortcut Menu
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            View and edit common workspace shortcuts.
          </p>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-2">
          {quickShortcuts.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No shortcuts available.
            </div>
          ) : (
            <div className="space-y-1">
              {quickShortcuts.map((shortcut) => (
                <ShortcutRecorder
                  key={shortcut.id}
                  shortcut={shortcut}
                  allShortcuts={shortcuts}
                  onUpdate={handleUpdate}
                  onReset={handleReset}
                  variant="compact"
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
