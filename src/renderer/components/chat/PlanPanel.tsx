import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CheckCircle2, Circle, ListChecks, Loader2 } from 'lucide-react'
import type { PlanEntry } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'
import { ScrollArea } from '../ui/scroll-area'
import { CHAT_GUTTER_X } from './chat-layout'
import { CHAT_SPRING_SOFT, iconPop } from './chat-motion'

interface PlanPanelProps {
  entries: PlanEntry[]
}

const PRIORITY_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Med',
  low: 'Low'
}

const PRIORITY_CLASS: Record<string, string> = {
  high: 'bg-destructive/15 text-destructive',
  medium: 'bg-warning/15 text-warning',
  low: 'bg-muted text-muted-foreground'
}

function getPlanDetail(entry: PlanEntry): string | undefined {
  const directDetail = entry.detail
  if (typeof directDetail === 'string' && directDetail.trim()) {
    return directDetail
  }

  const metadata = entry._meta
  if (metadata && typeof metadata === 'object' && 'detail' in metadata) {
    const metadataDetail = metadata.detail
    if (typeof metadataDetail === 'string' && metadataDetail.trim()) {
      return metadataDetail
    }
  }

  return undefined
}

function StatusIcon({ status }: { status?: string }): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const pop = iconPop(reduced)
  const icon =
    status === 'completed' ? (
      <CheckCircle2 size={13} className="text-success" />
    ) : status === 'in_progress' ? (
      <Loader2 size={13} className="animate-spin text-warning motion-reduce:animate-none" />
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

function getPlanEntryIdentity(entry: PlanEntry): string {
  const id = entry.id
  return typeof id === 'string' && id.trim() ? id : entry.content
}

function PriorityBadge({ priority }: { priority?: string }): React.JSX.Element {
  const key = priority && PRIORITY_LABEL[priority] ? priority : 'low'
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-px text-3xs font-medium tabular-nums',
        PRIORITY_CLASS[key]
      )}
    >
      {PRIORITY_LABEL[key]}
    </span>
  )
}

function EntryLabel({ entry }: { entry: PlanEntry }): React.JSX.Element {
  return (
    <>
      <StatusIcon status={entry.status} />
      <PriorityBadge priority={entry.priority} />
      <span
        className={cn(
          'min-w-0 flex-1 text-pretty break-words',
          entry.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'
        )}
      >
        {entry.content}
      </span>
    </>
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
              <ScrollArea className="max-h-60 border-t border-border/40">
                <Accordion
                  type="single"
                  collapsible
                  className="flex flex-col gap-0.5 px-2.5 pb-2.5 pt-1.5"
                >
                  {entries.map((entry, i) => {
                    const detail = getPlanDetail(entry)
                    const entryValue = `entry-${getPlanEntryIdentity(entry)}`
                    const motionProps = {
                      initial: reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' },
                      animate: reduced ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' },
                      transition: {
                        ...(reduced ? { duration: 0.15 } : CHAT_SPRING_SOFT),
                        delay: reduced ? 0 : Math.min(i, 8) * 0.08
                      }
                    }

                    return detail ? (
                      <motion.div key={entryValue} {...motionProps}>
                        <AccordionItem value={entryValue} className="border-0">
                          <AccordionTrigger className="min-h-8 gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:no-underline">
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <EntryLabel entry={entry} />
                            </span>
                          </AccordionTrigger>
                          <AccordionContent className="pl-8 pr-2 text-xs text-muted-foreground">
                            {detail}
                          </AccordionContent>
                        </AccordionItem>
                      </motion.div>
                    ) : (
                      <motion.div
                        key={entryValue}
                        {...motionProps}
                        className="flex min-h-8 items-center gap-2 rounded-md px-1.5 text-xs"
                      >
                        <EntryLabel entry={entry} />
                      </motion.div>
                    )
                  })}
                </Accordion>
              </ScrollArea>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
