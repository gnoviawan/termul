import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { Terminal, TerminalLine } from '@/types/project'

interface TerminalViewProps {
  terminal: Terminal
  splitView?: boolean
}

export function TerminalView({ terminal, splitView = false }: TerminalViewProps) {
  return (
    <div
      className={cn(
        'flex-1 flex flex-col bg-terminal-bg min-w-[200px]',
        splitView && 'border-r border-border'
      )}
    >
      <div className="h-full p-4 font-mono text-sm overflow-y-auto">
        {terminal.output?.map((line, index) => (
          <TerminalLineItem key={index} line={line} />
        ))}

        {/* Blinking cursor */}
        <div className="mt-2 inline-block terminal-cursor" />
      </div>
    </div>
  )
}

function TerminalLineItem({ line }: { line: TerminalLine }) {
  const colorClass = {
    command: 'text-terminal-fg',
    output: 'text-muted-foreground',
    error: 'text-destructive',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
    success: 'text-green-400'
  }[line.type]

  // Parse git branch syntax
  if (line.content.includes('git:(')) {
    const parts = line.content.split(/(git:\([^)]+\))/)
    return (
      <div className={cn(colorClass, 'leading-relaxed')}>
        {parts.map((part, i) => {
          if (part.startsWith('git:(')) {
            const branch = part.match(/git:\(([^)]+)\)/)?.[1]
            return (
              <span key={i}>
                git:(<span className="text-primary">{branch}</span>)
              </span>
            )
          }
          return <span key={i}>{part}</span>
        })}
      </div>
    )
  }

  return (
    <div className={cn(colorClass, 'leading-relaxed whitespace-pre-wrap')}>
      {line.content || '\u00A0'}
    </div>
  )
}

export function EmptyTerminalPane({ onCreateTerminal }: { onCreateTerminal: () => void }) {
  const { t } = useTranslation('terminal')

  return (
    <div className="flex-1 flex flex-col min-w-[200px] bg-surface-darker">
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <h3 className="text-muted-foreground font-medium mb-4">{t('emptyPane.title')}</h3>
        <div className="flex items-center gap-2 mb-4">
          <label className="label-section text-muted-foreground">{t('emptyPane.shell')}</label>
          <select className="bg-secondary text-foreground text-sm border-none rounded px-2 py-1 focus:ring-1 focus:ring-primary cursor-pointer">
            <option>{t('emptyPane.shells.powerShell')}</option>
            <option>{t('emptyPane.shells.commandPrompt')}</option>
            <option>{t('emptyPane.shells.wslUbuntu')}</option>
            <option>{t('emptyPane.shells.gitBash')}</option>
          </select>
        </div>
        <button
          onClick={onCreateTerminal}
          className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium py-1.5 px-4 rounded shadow-lg shadow-primary/20 transition-all flex items-center"
        >
          {t('emptyPane.create')}
        </button>
      </div>
    </div>
  )
}
