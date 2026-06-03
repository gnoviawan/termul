import { CheckCircle2, Circle, ListChecks, Loader2 } from 'lucide-react'
import type { PlanEntry } from '@/lib/acp-api'
import { cn } from '@/lib/utils'

interface PlanPanelProps {
  entries: PlanEntry[]
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-red-400',
  medium: 'bg-amber-400',
  low: 'bg-muted-foreground/50'
}

function StatusIcon({ status }: { status?: string }): React.JSX.Element {
  if (status === 'completed') return <CheckCircle2 size={13} className="text-green-400" />
  if (status === 'in_progress')
    return <Loader2 size={13} className="animate-spin text-amber-400 motion-reduce:animate-none" />
  return <Circle size={13} className="text-muted-foreground/60" />
}

/** Execution plan panel. Renders nothing when there are no entries. */
export function PlanPanel({ entries }: PlanPanelProps): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="mx-4 my-2 rounded-md border border-border/50 bg-card/30">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">
        <ListChecks size={12} />
        Plan
      </div>
      <ul className="flex flex-col gap-1 px-3 py-2">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            <StatusIcon status={entry.status} />
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                PRIORITY_DOT[entry.priority ?? 'low'] ?? 'bg-muted-foreground/50'
              )}
              title={`priority: ${entry.priority ?? 'low'}`}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                entry.status === 'completed'
                  ? 'text-muted-foreground line-through'
                  : 'text-foreground'
              )}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
