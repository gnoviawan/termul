import { ClipboardPaste, Keyboard } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { clipboardApi } from '@/lib/clipboard-api'
import { terminalApi } from '@/lib/terminal-api'
import { cn } from '@/lib/utils'

interface MobileTerminalControlsProps {
  terminalId: string
}

const KEYS = [
  ['Esc', '\u001b'],
  ['Tab', '\t'],
  ['Ctrl+C', '\u0003'],
  ['←', '\u001b[D'],
  ['↑', '\u001b[A'],
  ['↓', '\u001b[B'],
  ['→', '\u001b[C'],
  ['PgUp', '\u001b[5~'],
  ['PgDn', '\u001b[6~']
] as const

export function MobileTerminalControls({
  terminalId
}: MobileTerminalControlsProps): React.JSX.Element {
  const { t } = useTranslation('mobile')
  const [expanded, setExpanded] = useState(true)

  const write = async (data: string): Promise<void> => {
    const result = await terminalApi.write(terminalId, data)
    if (!result.success) {
      toast.error(t('terminalControls.writeFailed', { message: result.error }))
    }
  }

  const paste = async (): Promise<void> => {
    const result = await clipboardApi.readText()
    if (!result.success) {
      toast.error(t('terminalControls.clipboardReadFailed', { message: result.error }))
      return
    }
    if (result.data) {
      const writeResult = await terminalApi.write(terminalId, result.data)
      if (!writeResult.success) {
        toast.error(t('terminalControls.pasteFailed', { message: writeResult.error }))
      }
    }
  }

  return (
    <div className="shrink-0 border-t border-border/60 bg-card/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur">
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10 shrink-0 px-3"
          aria-label={expanded ? t('terminalControls.hideKeys') : t('terminalControls.showKeys')}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Keyboard size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10 shrink-0 gap-1 px-3"
          onClick={() => void paste()}
        >
          <ClipboardPaste size={15} />
          {t('terminalControls.paste')}
        </Button>
        {KEYS.map(([label, data]) => (
          <Button
            key={label}
            type="button"
            variant="secondary"
            size="sm"
            className={cn('h-10 min-w-10 shrink-0 px-3 font-mono', !expanded && 'hidden')}
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
