/**
 * GPUIX override of `components/terminal/TerminalAssistPanel.tsx`.
 *
 * The same card inside the terminal pane. The response renders through the
 * native `<markdown>` (with the chat thought theme, 12px) instead of the
 * sanitized HTML string the web injects; suggested commands come from the
 * shared `extractSuggestedCommands` and are inserted for review, never run.
 */
import type React from 'react'
import { useEffect, useMemo } from 'react'
import { Sparkles, X } from '@/components/icons'
import { extractSuggestedCommands } from '@/components/terminal/terminal-assist-commands'
import { Button } from '@/components/ui/button'
import { useColorTheme } from '@/stores/app-settings-store'
import { transcriptThemes } from '../../../chat/theme'
import { tw } from '../../../style/tw'

export { extractSuggestedCommands }

export interface TerminalAssistPanelState {
  kind: 'explain' | 'fix'
  status: 'loading' | 'done' | 'error'
  text?: string
  error?: string
}

interface TerminalAssistPanelProps {
  state: TerminalAssistPanelState
  onClose: () => void
  onInsertCommand: (command: string) => void
}

const ICON_BUTTON =
  'flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
const COMMAND_BUTTON =
  'mb-1 flex w-full flex-row items-center gap-2 rounded border border-border/60 px-2 py-1 text-left font-mono text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground'

export function TerminalAssistPanel({
  state,
  onClose,
  onInsertCommand
}: TerminalAssistPanelProps): React.JSX.Element {
  const themeId = useColorTheme()
  const commands = useMemo(
    () => (state.status === 'done' && state.text ? extractSuggestedCommands(state.text) : []),
    [state.status, state.text]
  )
  const title = state.kind === 'fix' ? 'Fix command' : 'Explain output'

  // Esc closes the panel (keyboard parity with the close button).
  useEffect(() => {
    const target = (globalThis as { window?: EventTarget }).window
    if (!target) return
    const onKey = (event: Event): void => {
      if ((event as KeyboardEvent).key === 'Escape') onClose()
    }
    target.addEventListener('keydown', onKey)
    return () => target.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // biome-ignore lint/a11y/useSemanticElements: GPUIX has no <aside>; the role carries the web's landmark
    <div
      role="complementary"
      aria-label={`Terminal AI assist — ${title}`}
      style={tw(
        'absolute bottom-3 right-3 z-20 flex w-[420px] flex-col rounded-lg border border-border/70 bg-card shadow-lg'
      )}
    >
      <div style={tw('flex flex-row items-center gap-2 border-b border-border/60 px-3 py-2')}>
        <Sparkles className="size-3.5 text-muted-foreground" />
        <text style={tw('flex-1 text-xs font-medium text-foreground')}>{title}</text>
        <Button
          type="button"
          variant={null}
          size={null}
          aria-label="Close terminal assist"
          data-testid="terminal-assist-close"
          onClick={onClose}
          className={ICON_BUTTON}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div
        style={{ ...tw('flex max-h-72 flex-col overflow-y-auto px-3 py-2'), overflowY: 'scroll' }}
      >
        {state.status === 'loading' ? (
          <text style={tw('text-xs text-muted-foreground')}>Asking the configured agent…</text>
        ) : state.status === 'error' ? (
          <text style={tw('text-xs text-destructive')}>
            {state.error ?? 'Terminal assist failed'}
          </text>
        ) : (
          <markdown
            source={state.text ?? ''}
            theme={transcriptThemes(themeId).thought}
            style={{ flexShrink: 0, minWidth: 0 }}
          />
        )}
      </div>
      {commands.length > 0 ? (
        <div style={tw('flex flex-col border-t border-border/60 px-3 py-2')}>
          <text style={tw('mb-1 text-xs font-medium text-muted-foreground')}>
            Suggested commands — inserted for review, never run
          </text>
          {commands.map((command, i) => (
            <Button
              key={`cmd-${i}`}
              type="button"
              variant={null}
              size={null}
              title={command}
              aria-label={`Insert suggested command ${i + 1}`}
              onClick={() => onInsertCommand(command)}
              className={COMMAND_BUTTON}
            >
              <text style={tw('truncate')}>{command}</text>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
