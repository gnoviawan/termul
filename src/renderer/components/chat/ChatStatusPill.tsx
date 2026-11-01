import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight, FileDiff } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { ChangedFilesRows, openChangedFile } from './ChangedFilesList'
import { CHAT_SPRING_SOFT } from './chat-motion'
import { SlidingTabs } from './SlidingTabs'
import {
  RunningIcon,
  SubagentCountParts,
  SubagentDetails,
  SubagentRows,
  subagentCountSummary
} from './SubagentList'
import { useChatChangedFiles } from './use-chat-changed-files'
import { useBackgroundWait, useCurrentTurnSubagents } from './use-current-turn-subagents'

export type StatusTab = 'files' | 'subagents'

/** Tab order; a tab is listed only while it has rows. */
const STATUS_TABS: readonly StatusTab[] = ['files', 'subagents']

interface ChatStatusPillProps {
  sessionId: string
  cwd: string
  toolCalls: ToolCall[]
  messages: readonly ChatMessage[]
  /** Session `activeTurn`: a subagent with no status yet counts as running while true; its end refreshes git state. */
  turnActive: boolean
  filePathContext: FilePathResolutionContext | undefined
  /**
   * Phone shell: a "Git" action beside the changed-files totals opens the Git
   * sheet. It is called with the pill, which the Git sheet returns focus to.
   */
  onOpenGitChanges?: (opener: HTMLElement) => void
  /** Hide the pill (phone keyboard open, reconnect notice in the same corner). */
  hidden?: boolean
  /** False while the chat tab is hidden (tabs stay mounted); closes the list. */
  isVisible?: boolean
  className?: string
}

/** What one kind of status shows: its tab label, its header, and its rows. */
interface StatusSection {
  title: string
  icon: ReactNode
  count: number
  /** Header line under the tab bar, where the tab label already names the kind. */
  caption: string
  /** Right side of the header: totals and actions. */
  meta: ReactNode
  rows: ReactNode
}

function CountBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border bg-secondary px-1.5 text-3xs font-semibold tabular-nums">
      {count}
    </span>
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Floating top-right status pill for the chat: the current turn's subagents
 * and the files the chat changed. Takes no layout height. Opens one popover
 * (desktop) or bottom sheet (phone); with both kinds present its content has
 * a tab per kind, and switching tabs slides inside the open overlay. Narrow
 * panes collapse the pill to icons and totals via the chat `@container`.
 */
export function ChatStatusPill({
  sessionId,
  cwd,
  toolCalls,
  messages,
  turnActive,
  filePathContext,
  onOpenGitChanges,
  hidden = false,
  isVisible = true,
  className
}: ChatStatusPillProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const isMobile = useMobileWebShell()
  const [open, setOpen] = useState(false)
  const [pickedTab, setPickedTab] = useState<StatusTab | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Set while focus is handed to the Git sheet, so closing this sheet does not
  // pull focus back to the pill underneath it.
  const handingOffFocus = useRef(false)

  const changes = useChatChangedFiles(cwd, toolCalls, turnActive)
  const { subagents, counts, endedAt } = useCurrentTurnSubagents(toolCalls, messages, turnActive)
  const waiting = useBackgroundWait(sessionId, toolCalls, messages, turnActive)
  const waitingLabel = waiting > 0 ? `Waiting on ${plural(waiting, 'background subagent')}` : null
  const fileCount = changes.files.length
  const tabs = STATUS_TABS.filter((tab) => (tab === 'files' ? fileCount > 0 : subagents.length > 0))
  const activeTab = pickedTab && tabs.includes(pickedTab) ? pickedTab : tabs[0]
  const shown = tabs.length > 0 && !hidden

  const close = useCallback(() => setOpen(false), [])
  useOverlayRegistration('chat-status-sheet', isMobile && open && shown, close)
  // Hidden tabs stay mounted and the list renders in a portal, so close it
  // or it would float over the next tab.
  useEffect(() => {
    if (!shown || !isVisible) setOpen(false)
  }, [shown, isVisible])

  const subagentSummary = subagentCountSummary(counts)
  const hasTotals = changes.totalAdded > 0 || changes.totalRemoved > 0
  const listClassName = isMobile ? 'max-h-[min(22.5rem,55dvh)]' : 'max-h-72'

  const totals = hasTotals && (
    <span className="font-mono tabular-nums">
      <DiffStatCounts added={changes.totalAdded} removed={changes.totalRemoved} />
    </span>
  )
  const gitAction = onOpenGitChanges && (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label="Open Git changes"
      onClick={() => {
        const opener = triggerRef.current
        if (!opener) return
        handingOffFocus.current = true
        setOpen(false)
        onOpenGitChanges(opener)
      }}
      className="relative shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] [&_svg]:size-3"
    >
      Git
      <ChevronRight size={12} aria-hidden="true" />
    </Button>
  )

  const sections: Record<StatusTab, StatusSection> = {
    files: {
      title: 'Changed files',
      icon: <FileDiff size={13} className="shrink-0" aria-hidden="true" />,
      count: fileCount,
      caption: changes.source === 'git' ? 'Uncommitted in this checkout' : 'Edited this session',
      meta: (
        <>
          {totals}
          {gitAction}
        </>
      ),
      rows: (
        <ChangedFilesRows
          files={changes.files}
          rowBase={changes.rowBase}
          className={listClassName}
          onOpen={(path) => {
            setOpen(false)
            void openChangedFile(path)
          }}
        />
      )
    },
    subagents: {
      title: 'Subagents',
      icon: <Bot size={13} className="shrink-0" aria-hidden="true" />,
      count: subagents.length,
      caption: 'This turn',
      meta: <SubagentCountParts counts={counts} />,
      rows: (
        <>
          {waitingLabel && (
            <p className="px-2.5 pb-1 text-2xs text-muted-foreground">{waitingLabel}</p>
          )}
          <SubagentRows
            subagents={subagents}
            turnActive={turnActive}
            endedAt={endedAt}
            running={counts.running}
            className={listClassName}
            onSelect={(id) => {
              setOpen(false)
              setSelectedId(id)
            }}
          />
        </>
      )
    }
  }

  const header = (section: StatusSection, titled: boolean) => (
    <div
      className={cn(
        'flex min-h-8 items-center gap-1.5 px-2.5 py-1 text-2xs text-muted-foreground',
        isMobile && titled && 'min-h-11 pr-10 text-sm'
      )}
    >
      {titled ? (
        <>
          {section.icon}
          {isMobile ? (
            <SheetTitle className="text-sm font-semibold text-foreground">
              {section.title}
            </SheetTitle>
          ) : (
            <span className="font-semibold text-foreground">{section.title}</span>
          )}
          <CountBadge count={section.count} />
        </>
      ) : (
        <span>{section.caption}</span>
      )}
      <span className="ms-auto flex items-center gap-1 tabular-nums">{section.meta}</span>
    </div>
  )

  const single = tabs.length === 1 ? sections[tabs[0]] : null
  const overlayLabel = single ? single.title : 'Session status'
  const content = single ? (
    <>
      {header(single, true)}
      {single.rows}
    </>
  ) : (
    <>
      {isMobile && <SheetTitle className="sr-only">{overlayLabel}</SheetTitle>}
      <SlidingTabs
        label={overlayLabel}
        active={activeTab}
        onActiveChange={setPickedTab}
        swipe={isMobile}
        tabListClassName={isMobile ? 'me-10' : undefined}
        tabs={tabs.map((tab) => ({
          id: tab,
          label: (
            <>
              {sections[tab].icon}
              {sections[tab].title}
              <CountBadge count={sections[tab].count} />
            </>
          ),
          panel: (
            <>
              {header(sections[tab], false)}
              {sections[tab].rows}
            </>
          )
        }))}
      />
    </>
  )

  const triggerLabel = [
    subagents.length > 0 && `subagents ${subagentSummary}`,
    waitingLabel?.toLowerCase(),
    fileCount > 0 && plural(fileCount, 'changed file')
  ]
    .filter(Boolean)
    .join('; ')

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={`Session status: ${triggerLabel}`}
      title={waitingLabel ?? undefined}
      className={cn(
        'pointer-events-auto relative flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-popover/90 px-2.5 text-2xs font-medium shadow-pill backdrop-blur-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted',
        "after:absolute after:-inset-2 after:content-[''] pointer-coarse:after:-inset-y-2.5"
      )}
    >
      {subagents.length > 0 && (
        <>
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
            className={cn(
              'tabular-nums text-foreground',
              !isMobile && 'hidden @max-[420px]:inline'
            )}
          >
            {subagents.length}
          </span>
        </>
      )}
      {subagents.length > 0 && fileCount > 0 && (
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
      )}
      {fileCount > 0 && (
        <>
          <FileDiff size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="tabular-nums text-foreground">{fileCount}</span>
          {!isMobile && hasTotals && (
            <span className="font-mono tabular-nums @max-[420px]:hidden">
              <DiffStatCounts added={changes.totalAdded} removed={changes.totalRemoved} />
            </span>
          )}
        </>
      )}
    </button>
  )

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {shown && subagents.length > 0 ? (waitingLabel ?? `Subagents: ${subagentSummary}`) : ''}
      </span>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key="chat-status-pill"
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
                  onCloseAutoFocus={(event) => {
                    if (!handingOffFocus.current) return
                    handingOffFocus.current = false
                    event.preventDefault()
                  }}
                  className="flex max-h-[85dvh] flex-col gap-0 overscroll-contain bg-popover p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
                >
                  {content}
                </SheetContent>
              </Sheet>
            ) : (
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={6}
                  aria-label={overlayLabel}
                  className="w-[min(22.5rem,calc(100vw-2rem))] rounded-[calc(var(--radius)+2px)] p-1 shadow-menu"
                >
                  {content}
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
