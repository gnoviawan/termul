import { useId, useState } from 'react'
import { toast } from 'sonner'
import { ClipboardPaste, Keyboard } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { clipboardApi } from '@/lib/clipboard-api'
import { terminalApi } from '@/lib/terminal-api'
import { cn } from '@/lib/utils'

interface MobileTerminalControlsProps {
  terminalId: string
}

// [visible label, escape sequence, spoken name]. Speech engines misread the
// bare glyphs ("leftwards arrow", "P G up"), so each key's accessible name is
// a spoken form. Text keys keep their visible label at the start of the name
// (WCAG 2.5.3); the three arrow keys are symbols, not text, so they get plain
// word names instead.
const KEYS = [
  ['Esc', '\u001b', 'Esc, escape'],
  ['Tab', '\t', 'Tab'],
  ['Ctrl+C', '\u0003', 'Ctrl+C, interrupt'],
  ['←', '\u001b[D', 'Left arrow'],
  ['↑', '\u001b[A', 'Up arrow'],
  ['↓', '\u001b[B', 'Down arrow'],
  ['→', '\u001b[C', 'Right arrow'],
  ['PgUp', '\u001b[5~', 'PgUp, page up'],
  ['PgDn', '\u001b[6~', 'PgDn, page down']
] as const

export function MobileTerminalControls({
  terminalId
}: MobileTerminalControlsProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const keyGroupId = useId()

  const write = async (data: string): Promise<void> => {
    const result = await terminalApi.write(terminalId, data)
    if (!result.success) {
      toast.error(`Terminal write failed: ${result.error}`)
    }
  }

  const paste = async (): Promise<void> => {
    const result = await clipboardApi.readText()
    if (!result.success) {
      toast.error(`Clipboard read failed: ${result.error}`)
      return
    }
    if (result.data) {
      const writeResult = await terminalApi.write(terminalId, result.data)
      if (!writeResult.success) {
        toast.error(`Paste failed: ${writeResult.error}`)
      }
    }
  }

  return (
    <div className="shrink-0 border-t border-border/60 bg-card/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur">
      {/* #859: horizontal scroll hid arrows/PgDn off-screen at 390px — the
          keys now wrap into a second row on narrow viewports instead of
          scrolling, so every key stays visible and tappable. The group is that
          wrap container (toggle, Paste and the nine keys). Pointer-down is
          prevented on every button so xterm keeps focus and the on-screen
          keyboard stays up; click still fires. */}
      <div
        id={keyGroupId}
        role="group"
        aria-label="Terminal keys"
        className="flex flex-wrap items-center gap-1"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 min-w-11 shrink-0 px-3"
          aria-label="Show/hide key bar"
          aria-expanded={expanded}
          aria-controls={keyGroupId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <Keyboard size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 min-w-11 shrink-0 gap-1 px-3"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void paste()}
        >
          <ClipboardPaste size={15} />
          Paste
        </Button>
        {KEYS.map(([label, data, name]) => (
          <Button
            key={label}
            type="button"
            variant="secondary"
            size="sm"
            className={cn('h-11 min-w-11 shrink-0 px-3 font-mono', !expanded && 'hidden')}
            aria-label={name}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void write(data)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}
