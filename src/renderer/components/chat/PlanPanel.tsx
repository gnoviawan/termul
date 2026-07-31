import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CheckCircle2, Circle, ListChecks, Loader2 } from 'lucide-react'
import type { PlanEntry } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { CHAT_GUTTER_X } from './chat-layout'
import { CHAT_SPRING_SOFT, iconPop } from './chat-motion'

interface PlanPanelProps {
  entries: PlanEntry[]
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-red-400',
  medium: 'bg-amber-400',
  low: 'bg-muted-foreground/50'
}

function StatusIcon({ status }: { status?: string }): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const pop = iconPop(reduced)
  const icon =
    status === 'completed' ? (
      <CheckCircle2 size={13} className="text-green-400" />
    ) : status === 'in_progress' ? (
      <Loader2 size={13} className="animate-spin text-amber-400 motion-reduce:animate-none" />
    ) : (
      <Circle size={13} className="text-muted-foreground/60" />
    )

  return (
    <motion.span
      key={status ?? 'pending'}
      aria-hidden="true"
      className="inline-flex shrink-0"
      initial={pop.initial}
      animate={pop.animate}
      transition={pop.transition}
    >
      {icon}
    </motion.span>
  )
}

/** Execution plan panel. Renders nothing when there are no entries. */
export function PlanPanel({ entries }: PlanPanelProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const completed = entries.filter((e) => e.status === 'completed').length

  return (
    <AnimatePresence initial={false}>
      {entries.length > 0 && (
        <motion.div
          key="plan"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={reduced ? { duration: 0.15 } : CHAT_SPRING_SOFT}
          className="shrink-0"
        >
          <div className={cn(CHAT_GUTTER_X, 'py-2')}>
            <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-lg bg-card/30 shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] ring-1 ring-border/50">
              <div className="flex items-center gap-1.5 px-3 py-2 text-2xs font-semibold text-muted-foreground">
                <ListChecks size={12} className="shrink-0" aria-hidden="true" />
                <span className="text-balance">Plan</span>
                <span className="ml-auto tabular-nums text-muted-foreground/70">
                  {completed}
                  <span className="text-muted-foreground/40">/</span>
                  {entries.length}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5 border-t border-border/40 px-2.5 pb-2.5 pt-1.5">
                {entries.map((entry, i) => (
                  <motion.li
                    key={`${entry.content}-${i}`}
                    className="flex min-h-8 items-center gap-2 rounded-md px-1.5 text-xs"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
                    animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
                    transition={{
                      ...(reduced ? { duration: 0.15 } : CHAT_SPRING_SOFT),
                      delay: reduced ? 0 : Math.min(i, 8) * 0.08
                    }}
                  >
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
                        'min-w-0 flex-1 text-pretty break-words',
                        entry.status === 'completed'
                          ? 'text-muted-foreground line-through'
                          : 'text-foreground'
                      )}
                    >
                      {entry.content}
                    </span>
                  </motion.li>
                ))}
              </ul>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
