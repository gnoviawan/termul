import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw } from '@/components/icons'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { beginShortcutCapture, endShortcutCapture } from '@/lib/shortcut-capture'
import {
  findConflictingShortcut,
  formatKeyForDisplay,
  normalizeKeyEvent
} from '@/stores/keyboard-shortcuts-store'
import type { KeyboardShortcut, KeyboardShortcutsConfig } from '@/types/settings'

interface ShortcutRecorderProps {
  shortcut: KeyboardShortcut
  allShortcuts: KeyboardShortcutsConfig
  onUpdate: (id: string, customKey: string) => void
  onReset: (id: string) => void
  /** `row` is the Preferences settings row (label left, keycaps right). */
  variant?: 'default' | 'compact' | 'row'
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
      if (
        !normalized ||
        normalized.split('+').every((p) => ['ctrl', 'cmd', 'meta', 'alt', 'shift'].includes(p))
      ) {
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
    window.removeEventListener('keydown', handleKeyDown, { capture: true })
    setIsRecording(false)
    setPendingKey(null)
    setConflict(null)
  }, [handleKeyDown])

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

  // Suspend the native app menu while recording so its accelerators (e.g. ⌘W,
  // ⌘R, ⌘C) stop intercepting keys before they reach the webview, letting the
  // user record any combination. Keyed only on `isRecording` so a change in
  // `handleKeyDown`'s identity does not churn the menu mid-recording.
  useEffect(() => {
    if (!isRecording) return
    void beginShortcutCapture()
    return () => {
      void endShortcutCapture()
    }
  }, [isRecording])

  // Attach the capture-phase keydown listener while recording. Re-binds when
  // `handleKeyDown` changes identity (e.g. after the shortcut map updates).
  useEffect(() => {
    if (isRecording && inputRef.current) {
      inputRef.current.focus()
      window.addEventListener('keydown', handleKeyDown, { capture: true })
      return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [isRecording, handleKeyDown])

  if (variant === 'row') {
    const keys = (isRecording && !pendingKey ? '' : displayKey).split('+').filter(Boolean)
    return (
      <div data-settings-row="" className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{shortcut.label}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {shortcut.description}
              {isCustomized && ` Default: ${formatKeyForDisplay(shortcut.defaultKey)}`}
            </p>
          </div>
          {isCustomized && (
            <button
              type="button"
              onClick={handleReset}
              className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${FOCUS_RING_CLASS}`}
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
            data-recording={isRecording ? 'true' : undefined}
            aria-label={`Record ${shortcut.label} shortcut`}
            onClick={handleClick}
            onBlur={handleBlur}
            onKeyDown={handleKeyboardActivate}
            className={`flex min-h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1 py-0.5 transition-colors duration-150 ease-out ${FOCUS_RING_CLASS} ${
              isRecording
                ? 'border-ring bg-background px-2'
                : conflict
                  ? 'border-destructive'
                  : 'border-transparent hover:bg-foreground/[0.03]'
            }`}
          >
            {keys.length === 0 ? (
              <span className="text-xs text-muted-foreground">Press keys…</span>
            ) : (
              keys.map((part, index) => (
                <kbd
                  // A part can repeat only in theory; the index keeps keys unique.
                  key={`${part}-${index}`}
                  className={`keycap inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 font-sans text-xs font-medium ${
                    isCustomized ? 'text-foreground' : 'text-secondary-foreground'
                  }`}
                >
                  {formatKeyForDisplay(part)}
                </kbd>
              ))
            )}
          </div>
        </div>
        {conflict && (
          <SettingsNotice
            tone="danger"
            action={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleConfirmWithConflict}
              >
                Use anyway
              </Button>
            }
          >
            Conflicts with "{conflict.label}". Both commands keep these keys if you use it anyway.
          </SettingsNotice>
        )}
      </div>
    )
  }

  if (variant === 'compact') {
    return (
      <div className="rounded-md px-2 py-1.5 hover:bg-secondary/40">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-secondary-foreground">
              {shortcut.label}
            </div>
            <div className="truncate text-2xs text-muted-foreground">{shortcut.description}</div>
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
            data-recording={isRecording ? 'true' : undefined}
            aria-label={`Record ${shortcut.label} shortcut`}
            onClick={handleClick}
            onBlur={handleBlur}
            onKeyDown={handleKeyboardActivate}
            className={`
              min-w-[88px] shrink-0 rounded-md border px-2 py-1 text-center font-mono text-2xs transition-[color,background-color,border-color,box-shadow] duration-150 ease-out cursor-pointer
              ${
                isRecording
                  ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                  : 'border-border bg-secondary/50 hover:bg-secondary'
              }
              ${conflict ? 'border-destructive' : ''}
              ${isCustomized ? 'text-primary' : 'text-foreground'}
            `}
          >
            {isRecording && !pendingKey ? (
              <span className="text-muted-foreground">Press keys…</span>
            ) : (
              formatKeyForDisplay(displayKey)
            )}
          </div>
        </div>

        {conflict && (
          <div className="mt-1 text-2xs text-destructive">
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
          role="button"
          data-shortcut-recorder="true"
          data-recording={isRecording ? 'true' : undefined}
          aria-label={`Record ${shortcut.label} shortcut`}
          onClick={handleClick}
          onBlur={handleBlur}
          onKeyDown={handleKeyboardActivate}
          className={`
            px-3 py-2 rounded-md border text-sm font-mono cursor-pointer transition-[color,background-color,border-color,box-shadow] duration-150 ease-out
            ${
              isRecording
                ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                : 'border-border bg-secondary/50 hover:bg-secondary'
            }
            ${conflict ? 'border-destructive' : ''}
            ${isCustomized ? 'text-primary' : 'text-foreground'}
          `}
        >
          {isRecording && !pendingKey ? (
            <span className="text-muted-foreground">Press keys…</span>
          ) : (
            formatKeyForDisplay(displayKey)
          )}
        </div>

        {conflict && (
          <div className="mt-2 text-xs text-destructive">
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
