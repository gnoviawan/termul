import { useState, useCallback, useRef, useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  normalizeKeyEvent,
  formatKeyForDisplay,
  findConflictingShortcut
} from '@/stores/keyboard-shortcuts-store'
import type { KeyboardShortcut, KeyboardShortcutsConfig } from '@/types/settings'

interface ShortcutRecorderProps {
  shortcut: KeyboardShortcut
  allShortcuts: KeyboardShortcutsConfig
  onUpdate: (id: string, customKey: string) => void
  onReset: (id: string) => void
}

export function ShortcutRecorder({
  shortcut,
  allShortcuts,
  onUpdate,
  onReset
}: ShortcutRecorderProps): React.JSX.Element {
  const [isRecording, setIsRecording] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [conflict, setConflict] = useState<KeyboardShortcut | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)

  const activeKey = shortcut.customKey ?? shortcut.defaultKey
  const isCustomized = shortcut.customKey !== undefined
  const displayKey = pendingKey ?? activeKey

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const normalized = normalizeKeyEvent(e)

      // Ignore if only modifiers pressed
      if (!normalized || normalized.split('+').every((p) => ['ctrl', 'alt', 'shift'].includes(p))) {
        return
      }

      // Check for escape to cancel
      if (e.key === 'Escape') {
        setIsRecording(false)
        setPendingKey(null)
        setConflict(null)
        return
      }

      setPendingKey(normalized)

      // Check for conflicts
      const conflicting = findConflictingShortcut(allShortcuts, normalized, shortcut.id)
      setConflict(conflicting ?? null)
    },
    [allShortcuts, shortcut.id]
  )

  const handleBlur = useCallback(() => {
    if (pendingKey && !conflict) {
      onUpdate(shortcut.id, pendingKey)
    }
    setIsRecording(false)
    setPendingKey(null)
    setConflict(null)
  }, [pendingKey, conflict, onUpdate, shortcut.id])

  const handleClick = useCallback(() => {
    if (!isRecording) {
      setIsRecording(true)
      setPendingKey(null)
      setConflict(null)
    }
  }, [isRecording])

  const handleConfirmWithConflict = useCallback(() => {
    if (pendingKey) {
      onUpdate(shortcut.id, pendingKey)
    }
    setIsRecording(false)
    setPendingKey(null)
    setConflict(null)
  }, [pendingKey, onUpdate, shortcut.id])

  const handleReset = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onReset(shortcut.id)
    },
    [onReset, shortcut.id]
  )

  // Attach keydown listener when recording
  useEffect(() => {
    if (isRecording && inputRef.current) {
      inputRef.current.focus()
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isRecording, handleKeyDown])

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-secondary-foreground">{shortcut.label}</span>
          {isCustomized && (
            <button
              onClick={handleReset}
              className="p-1 hover:bg-secondary rounded text-muted-foreground hover:text-foreground transition-colors"
              title="Reset to default"
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-2">{shortcut.description}</p>

        <div
          ref={inputRef}
          tabIndex={0}
          onClick={handleClick}
          onBlur={handleBlur}
          className={`
            px-3 py-2 rounded-md border text-sm font-mono cursor-pointer transition-all
            ${
              isRecording
                ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                : 'border-border bg-secondary/50 hover:bg-secondary'
            }
            ${conflict ? 'border-red-500' : ''}
            ${isCustomized ? 'text-primary' : 'text-foreground'}
          `}
        >
          {isRecording && !pendingKey ? (
            <span className="text-muted-foreground">Press keys...</span>
          ) : (
            formatKeyForDisplay(displayKey)
          )}
        </div>

        {conflict && (
          <div className="mt-2 text-xs text-red-500">
            Conflicts with "{conflict.label}".{' '}
            <button
              onClick={handleConfirmWithConflict}
              className="underline hover:no-underline"
            >
              Use anyway
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
