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
  variant?: 'default' | 'compact'
}

export function ShortcutRecorder({
  shortcut,
  allShortcuts,
  onUpdate,
  onReset,
  variant = 'default'
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

      // Check for escape to cancel before normalizing so Esc is never recorded.
      if (e.key === 'Escape') {
        setIsRecording(false)
        setPendingKey(null)
        setConflict(null)
        return
      }

      const normalized = normalizeKeyEvent(e)

      // Ignore if only modifiers pressed
      if (!normalized || normalized.split('+').every((p) => ['ctrl', 'cmd', 'meta', 'alt', 'shift'].includes(p))) {
        return
      }

      setPendingKey(normalized)

      // Check for conflicts
      const conflicting = findConflictingShortcut(allShortcuts, normalized, shortcut.id)
      setConflict(conflicting ?? null)

      if (!conflicting) {
        onUpdate(shortcut.id, normalized)
        setIsRecording(false)
        setPendingKey(null)
      }
    },
    [allShortcuts, onUpdate, shortcut.id]
  )

  const handleBlur = useCallback(() => {
    if (!conflict) {
      setIsRecording(false)
      setPendingKey(null)
    }
    setConflict(null)
  }, [conflict])

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

  const handleKeyboardActivate = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isRecording && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        handleClick()
      }
    },
    [handleClick, isRecording]
  )

  // Attach keydown listener when recording
  useEffect(() => {
    if (isRecording && inputRef.current) {
      inputRef.current.focus()
      window.addEventListener('keydown', handleKeyDown, { capture: true })
      return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [isRecording, handleKeyDown])

  if (variant === 'compact') {
    return (
      <div className="rounded-md px-2 py-1.5 hover:bg-secondary/40">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-secondary-foreground">
              {shortcut.label}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {shortcut.description}
            </div>
          </div>

          {isCustomized && (
            <button
              type="button"
              onClick={handleReset}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title="Reset to default"
              aria-label={`Reset ${shortcut.label} shortcut to default`}
            >
              <RotateCcw size={13} />
            </button>
          )}

          <div
            ref={inputRef}
            tabIndex={0}
            role="button"
            data-shortcut-recorder="true"
            aria-label={`Record ${shortcut.label} shortcut`}
            onClick={handleClick}
            onBlur={handleBlur}
            onKeyDown={handleKeyboardActivate}
            className={`
              min-w-[88px] shrink-0 rounded-md border px-2 py-1 text-center font-mono text-[11px] transition-all cursor-pointer
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
        </div>

        {conflict && (
          <div className="mt-1 text-[11px] text-red-500">
            Conflicts with "{conflict.label}".{' '}
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleConfirmWithConflict}
              className="underline hover:no-underline"
            >
              Use anyway
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-secondary-foreground">{shortcut.label}</span>
          {isCustomized && (
            <button
              type="button"
              onClick={handleReset}
              className="p-1 hover:bg-secondary rounded text-muted-foreground hover:text-foreground transition-colors"
              title="Reset to default"
              aria-label={`Reset ${shortcut.label} shortcut to default`}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-2">{shortcut.description}</p>

        <div
          ref={inputRef}
          tabIndex={0}
          data-shortcut-recorder="true"
          onClick={handleClick}
          onBlur={handleBlur}
          onKeyDown={handleKeyboardActivate}
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
              type="button"
              onMouseDown={(event) => event.preventDefault()}
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
