import { useId, useState } from 'react'
import { toast } from 'sonner'
import { ClipboardPaste, Keyboard } from '@/components/icons'
import {
  findEditorInputTarget,
  routeMobileKey
} from '@/components/terminal/command-editor/foreign-insert'
import { Button } from '@/components/ui/button'
import { useDockClearance } from '@/hooks/use-dock-clearance'
import { clipboardApi } from '@/lib/clipboard-api'
import {
  canTerminalWriteToPty,
  resolveLifecycleTerminalId
} from '@/lib/command-lifecycle/input-guard'
import { terminalApi } from '@/lib/terminal-api'
import { cn } from '@/lib/utils'
import { useTerminalStore } from '@/stores/terminal-store'

interface MobileTerminalControlsProps {
  terminalId: string
}

// [visible label, escape sequence, spoken name]. Speech engines misread the
// bare glyphs ("leftwards arrow", "P G up"), so each key's accessible name is
// a spoken form. Text keys keep their visible label at the start of the name
// (WCAG 2.5.3); the three arrow keys are symbols, not text, so they get plain
// word names instead.
function terminalWriteIds(terminalId: string): { lifecycleId: string; writeId: string } {
  const store = useTerminalStore.getState()
  const byId = store.terminals.find((terminal) => terminal.id === terminalId)
  if (byId) return { lifecycleId: byId.id, writeId: byId.ptyId ?? byId.id }
  const byPty = store.findTerminalByPtyId(terminalId)
  if (byPty) return { lifecycleId: byPty.id, writeId: byPty.ptyId ?? terminalId }
  return { lifecycleId: resolveLifecycleTerminalId(terminalId) ?? terminalId, writeId: terminalId }
}

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
  // The bar exists only on the mobile shell. It reports its top edge so a toast
  // clears the whole bar, one row or two (`useDockClearance`).
  const barRef = useDockClearance(true)

  const write = async (data: string): Promise<void> => {
    const { lifecycleId, writeId } = terminalWriteIds(terminalId)
    const target = findEditorInputTarget(terminalId)
    if (target) {
      await routeMobileKey(target, 'key', data, async (text) => {
        const result = await terminalApi.write(writeId, text)
        if (!result.success) toast.error(`Terminal write failed: ${result.error}`)
      })
      return
    }
    if (!canTerminalWriteToPty(lifecycleId, data)) return
    const result = await terminalApi.write(writeId, data)
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
      const { lifecycleId, writeId } = terminalWriteIds(terminalId)
      const target = findEditorInputTarget(terminalId)
      if (target) {
        await routeMobileKey(target, 'paste', result.data, async (text) => {
          const writeResult = await terminalApi.write(writeId, text)
          if (!writeResult.success) toast.error(`Paste failed: ${writeResult.error}`)
        })
        return
      }
      if (!canTerminalWriteToPty(lifecycleId, result.data)) return
      const writeResult = await terminalApi.write(writeId, result.data)
      if (!writeResult.success) {
        toast.error(`Paste failed: ${writeResult.error}`)
      }
    }
  }

  return (
    <div
      ref={barRef}
      className="shrink-0 border-t border-border/60 bg-card/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur"
    >
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
