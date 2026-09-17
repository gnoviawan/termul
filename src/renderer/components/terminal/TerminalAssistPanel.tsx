import { Sparkles, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo } from 'react'
import { renderChatMarkdown } from '@/lib/chat-markdown'
import { cn } from '@/lib/utils'

/**
 * Inline terminal AI assist panel (#259).
 *
 * Shows the agent's response to "explain this output" / "fix this command"
 * as an overlay card inside the terminal pane. Suggested commands are
 * extracted from fenced code blocks and offered for insertion — the caller
 * writes them to the terminal input; they are NEVER executed automatically
 * (the user presses Enter themselves).
 */
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

/**
 * Extract fenced code blocks (```sh / ```bash / bare ```) from a response.
 *
 * Only single-line commands without terminal control characters are offered
 * for insertion (#689 review): `terminalApi.write` forwards text straight to
 * the PTY, so a newline or control byte would execute the command — violating
 * the "inserted for review, never run" contract. Multi-line or tainted
 * blocks stay visible as markdown but get no Insert button.
 */
/** True when the text contains a newline or any terminal control character. */
function hasTerminalControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function extractSuggestedCommands(markdown: string): string[] {
  const commands: string[] = []
  const fenced = /```(?:sh|shell|bash)?\s*\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(fenced)) {
    const body = (match[1] ?? '').trim()
    if (body.length === 0) continue
    if (hasTerminalControlCharacter(body)) continue
    commands.push(body)
  }
  return commands
}

export function TerminalAssistPanel({
  state,
  onClose,
  onInsertCommand
}: TerminalAssistPanelProps): React.JSX.Element {
  const html = useMemo(
    () => (state.status === 'done' && state.text ? renderChatMarkdown(state.text) : null),
    [state.status, state.text]
  )
  const commands = useMemo(
    () => (state.status === 'done' && state.text ? extractSuggestedCommands(state.text) : []),
    [state.status, state.text]
  )
  const title = state.kind === 'fix' ? 'Fix command' : 'Explain output'

  // Esc closes the panel (keyboard parity with the close button).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <aside
      aria-label={`Terminal AI assist — ${title}`}
      className="absolute bottom-3 right-3 z-20 w-[420px] max-w-[calc(100%-1.5rem)] rounded-lg border border-border/70 bg-card shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Sparkles className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-foreground">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close terminal assist"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto px-3 py-2">
        {state.status === 'loading' ? (
          <p className="text-xs text-muted-foreground" role="status">
            Asking the configured agent…
          </p>
        ) : state.status === 'error' ? (
          <p className="text-xs text-red-400" role="alert">
            {state.error ?? 'Terminal assist failed'}
          </p>
        ) : (
          <div
            className={cn('prose prose-xs max-w-none break-words text-xs')}
            // Sanitized with DOMPurify inside renderChatMarkdown (chat parity).
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via renderChatMarkdown
            dangerouslySetInnerHTML={{ __html: html ?? '' }}
          />
        )}
      </div>
      {commands.length > 0 ? (
        <div className="border-t border-border/60 px-3 py-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Suggested commands — inserted for review, never run
          </p>
          {commands.map((command, i) => (
            <button
              key={`cmd-${i}`}
              type="button"
              onClick={() => onInsertCommand(command)}
              title={command}
              aria-label={`Insert suggested command ${i + 1}`}
              className="mb-1 flex w-full items-center gap-2 rounded border border-border/60 px-2 py-1 text-left font-mono text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <span className="truncate">{command}</span>
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  )
}
