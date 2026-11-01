import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { Bot, ChevronDown } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { CHAT_SPRING_SOFT } from './chat-motion'
import {
  RunningIcon,
  SubagentCountParts,
  SubagentDetails,
  SubagentRows,
  subagentCountSummary
} from './SubagentList'
import { useCurrentTurnSubagents } from './use-current-turn-subagents'

interface SubagentPillProps {
  toolCalls: readonly ToolCall[]
  messages: readonly ChatMessage[]
  /** Session `activeTurn`: a subagent with no status yet counts as running while true. */
  turnActive: boolean
  filePathContext: FilePathResolutionContext | undefined
  /** Hide the pill (phone keyboard open, reconnect notice in the same corner). */
  hidden?: boolean
  /** False while the chat tab is hidden (tabs stay mounted); pauses the timer. */
  isVisible?: boolean
  className?: string
}

/**
 * Floating top-right pill for the current turn's subagents. Takes no layout
 * height; opens a popover (desktop) or bottom sheet (phone) with one row per
 * subagent. Narrow panes collapse it to icon + total via the chat `@container`.
 */
export function SubagentPill({
  toolCalls,
  messages,
  turnActive,
  filePathContext,
  hidden = false,
  isVisible = true,
  className
}: SubagentPillProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const isMobile = useMobileWebShell()
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { subagents, counts, endedAt } = useCurrentTurnSubagents(toolCalls, messages, turnActive)
  const shown = subagents.length > 0 && !hidden

  const close = useCallback(() => setOpen(false), [])
  useOverlayRegistration('subagent-sheet', isMobile && open && shown, close)
  // Hidden tabs stay mounted and the list renders in a portal, so close it
  // or it would float over the next tab.
  useEffect(() => {
    if (!shown || !isVisible) setOpen(false)
  }, [shown, isVisible])

  const liveSummary = subagentCountSummary(counts)

  const rows = (
    <SubagentRows
      subagents={subagents}
      turnActive={turnActive}
      endedAt={endedAt}
      running={counts.running}
      onSelect={(id) => {
        setOpen(false)
        setSelectedId(id)
      }}
    />
  )

  const trigger = (
    <button
      type="button"
      aria-label={`Subagents: ${liveSummary}`}
      className={cn(
        'pointer-events-auto relative flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover/90 px-2.5 text-2xs font-medium shadow-pill backdrop-blur-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted',
        "after:absolute after:-inset-2 after:content-[''] pointer-coarse:after:-inset-y-2.5"
      )}
    >
      {counts.running > 0 ? (
        <RunningIcon />
      ) : (
        <Bot size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      {!isMobile && (
        <span className="flex items-center gap-1 tabular-nums @max-[420px]:hidden">
          <SubagentCountParts counts={counts} />
        </span>
      )}
      <span
        className={cn('tabular-nums text-foreground', !isMobile && 'hidden @max-[420px]:inline')}
      >
        {subagents.length}
      </span>
      {!isMobile && (
        <ChevronDown
          size={12}
          className="shrink-0 text-muted-foreground @max-[420px]:hidden"
          aria-hidden="true"
        />
      )}
    </button>
  )

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {shown ? `Subagents: ${liveSummary}` : ''}
      </span>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key="subagent-pill"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            transition={reduced ? { duration: 0 } : CHAT_SPRING_SOFT}
            className={cn('pointer-events-none origin-top-right', className)}
          >
            {isMobile ? (
              <Sheet open={open} onOpenChange={setOpen}>
                <SheetTrigger asChild>{trigger}</SheetTrigger>
                <SheetContent
                  side="bottom"
                  aria-describedby={undefined}
                  className="flex max-h-[85dvh] flex-col gap-0 overscroll-contain bg-popover p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
                >
                  <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
                    <SheetTitle className="text-base">Subagents</SheetTitle>
                    <p className="flex items-center gap-1 text-xs tabular-nums">
                      <SubagentCountParts counts={counts} />
                    </p>
                  </SheetHeader>
                  {rows}
                </SheetContent>
              </Sheet>
            ) : (
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={6}
                  aria-label="Subagents"
                  className="w-[min(22.5rem,calc(100vw-2rem))] rounded-[calc(var(--radius)+2px)] p-1 shadow-menu"
                >
                  <p className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2 text-2xs font-semibold text-muted-foreground">
                    <Bot size={12} className="shrink-0" aria-hidden="true" />
                    Subagents · this turn
                  </p>
                  {rows}
                </PopoverContent>
              </Popover>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <SubagentDetails
        toolCalls={toolCalls}
        subagents={subagents}
        selectedId={selectedId}
        turnActive={turnActive}
        filePathContext={filePathContext}
        onClose={() => setSelectedId(null)}
      />
    </>
  )
}
