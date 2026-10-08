import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useId } from 'react'
import { CheckCircle2, ChevronDown, Circle, ListChecks } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import type { PlanEntry } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'
import { CollapseExpandMotion } from '../ui/collapse-expand-motion'
import { CHAT_GUTTER_X, CHAT_HIT_MIN_H, CHAT_ROW_MIN_H } from './chat-layout'
import { CHAT_SPRING_SOFT, iconPop } from './chat-motion'
import { useForcedCollapse } from './use-forced-collapse'

interface PlanPanelProps {
  entries: PlanEntry[]
  /** Start collapsed to the "Plan X/N" header bar (the mobile dock). Seeds local state at mount. */
  defaultCollapsed?: boolean
  /**
   * Render collapsed while true (the mobile dock, keyboard up with an approval
   * pending). A header tap during the window still flips the rendered state;
   * afterwards the bar shows the user's last own state.
   */
  forceCollapsed?: boolean
}

const PRIORITY_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low'
}

const PRIORITY_CLASS: Record<string, string> = {
  high: 'bg-destructive/15 text-destructive',
  medium: 'bg-warning/15 text-warning',
  low: 'bg-secondary text-muted-foreground'
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
      <Spinner size={13} decorative className="text-warning" />
    ) : (
      <Circle size={13} className="text-muted-foreground" />
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
export function PlanPanel({
  entries,
  defaultCollapsed = false,
  forceCollapsed = false
}: PlanPanelProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  // Collapse state is component-local: it survives `entries` changes so
  // mid-turn `acp:plan_update` events keep the user's collapse choice. Reset
  // only on unmount or session switch (the panel is remounted per session).
  const { collapsed, toggle } = useForcedCollapse(defaultCollapsed, forceCollapsed)
  // Unique id per PlanPanel instance so the sticky panel and an inline
  // historical renderer never collide on `id="plan-panel-body"`.
  const bodyId = useId()
  const completed = entries.filter((e) => e.status === 'completed').length
  const inProgressCount = entries.filter((e) => e.status === 'in_progress').length
  const hasInProgress = inProgressCount > 0
  const taskLabel = entries.length === 1 ? 'task' : 'tasks'
  const inProgressLabel =
    inProgressCount === 1 ? 'task in progress' : `${inProgressCount} tasks in progress`

  return (
    <AnimatePresence initial={false}>
      {entries.length > 0 && (
        <motion.div
          key="plan"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={reduced ? { duration: 0 } : CHAT_SPRING_SOFT}
          className="shrink-0"
        >
          <div className={cn(CHAT_GUTTER_X, 'py-2')}>
            <section
              className="mx-auto w-full max-w-3xl overflow-hidden rounded-lg bg-card/30 ring-1 ring-border/50"
              aria-label="Execution plan"
            >
              <button
                type="button"
                onClick={toggle}
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                aria-label={`Plan, ${completed} of ${entries.length} ${taskLabel}${
                  hasInProgress ? `, ${inProgressLabel}` : ''
                }`}
                className={cn(
                  'flex w-full items-center gap-1.5 px-3 py-2 text-left text-2xs font-semibold text-muted-foreground transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  CHAT_HIT_MIN_H
                )}
              >
                <ListChecks size={12} className="shrink-0" aria-hidden="true" />
                <span className="text-balance">Plan</span>
                {hasInProgress && <Spinner size={12} decorative className="ml-1 text-warning" />}
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {completed}
                  <span className="text-muted-foreground/40">/</span>
                  {entries.length}
                </span>
                <ChevronDown
                  size={14}
                  className={cn(
                    'shrink-0 text-muted-foreground transition-transform duration-[var(--acc-chevron)] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                    collapsed ? '' : 'rotate-180'
                  )}
                  aria-hidden="true"
                />
              </button>
              <CollapseExpandMotion open={!collapsed} motion="chat">
                <div
                  id={bodyId}
                  // Native overflow: Radix ScrollArea viewport is `h-full` and
                  // does not scroll when the parent only sets max-height.
                  className="scroller-thin max-h-60 overflow-y-auto overscroll-contain border-t border-border/40"
                >
                  <Accordion type="single" collapsible className="flex flex-col px-2 pb-1.5 pt-0.5">
                    {entries.map((entry, i) => {
                      const detail = getPlanDetail(entry)
                      const entryValue = `entry-${getPlanEntryIdentity(entry)}`
                      const motionProps = {
                        initial: reduced ? { opacity: 0 } : { opacity: 0, y: 6 },
                        animate: reduced ? { opacity: 1 } : { opacity: 1, y: 0 },
                        transition: {
                          ...(reduced ? { duration: 0 } : CHAT_SPRING_SOFT),
                          delay: reduced ? 0 : Math.min(i, 3) * 0.08
                        }
                      }

                      return detail ? (
                        <motion.div key={entryValue} {...motionProps}>
                          <AccordionItem value={entryValue} className="border-0">
                            <AccordionTrigger
                              className={cn(
                                'gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs hover:no-underline',
                                CHAT_ROW_MIN_H
                              )}
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
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
                          className={cn(
                            'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs',
                            CHAT_ROW_MIN_H
                          )}
                        >
                          <EntryLabel entry={entry} />
                        </motion.div>
                      )
                    })}
                  </Accordion>
                </div>
              </CollapseExpandMotion>
            </section>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
