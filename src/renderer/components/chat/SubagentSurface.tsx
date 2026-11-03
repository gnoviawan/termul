import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { SubagentPanel } from './SubagentPanel'
import { lastUserBoundary, subagentParentTurn, subagentStatus } from './subagent-strip'
import { type SubagentSurface, SubagentSurfaceContext } from './subagent-surface-context'

/** Chat width from which the panel docks beside the chat instead of sliding over it. */
const DOCK_MIN_PX = 720

interface PanelEntry {
  id: string
  siblings: readonly string[]
}

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: 'chat.subagentPanel', message })
}

/** Measured width of `ref`; 0 until laid out (jsdom stays 0). */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

interface SubagentSurfaceProps {
  sessionId: string
  agentId: string | undefined
  toolCalls: readonly ToolCall[]
  messages: readonly ChatMessage[]
  turnActive: boolean
  filePathContext: FilePathResolutionContext | undefined
  /** False while the chat tab is hidden; closes the panel. */
  isVisible: boolean
  children: ReactNode
}

/**
 * Owns a chat's subagent panel. Rows anywhere in the chat open it through
 * {@link SubagentSurfaceContext}. A wide desktop chat docks it on the right
 * so the transcript stays readable; a narrow pane slides it over from the
 * right, and the phone shows it as a full-height bottom sheet.
 */
export function SubagentSurfaceProvider({
  sessionId,
  agentId,
  toolCalls,
  messages,
  turnActive,
  filePathContext,
  isVisible,
  children
}: SubagentSurfaceProps): React.JSX.Element {
  const isMobile = useMobileWebShell()
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useWidth(rootRef)
  const docked = !isMobile && (width === 0 || width >= DOCK_MIN_PX)
  const [stack, setStack] = useState<PanelEntry[]>([])
  const top = stack[stack.length - 1] ?? null

  const open = useCallback<SubagentSurface['open']>((id, siblings, options) => {
    setStack((prev) =>
      options?.nested && prev.length > 0 ? [...prev, { id, siblings }] : [{ id, siblings }]
    )
  }, [])
  const close = useCallback(() => setStack([]), [])
  const back = useCallback(() => setStack((prev) => prev.slice(0, -1)), [])
  const step = useCallback((delta: -1 | 1) => {
    setStack((prev) => {
      const current = prev[prev.length - 1]
      if (!current) return prev
      const index = current.siblings.indexOf(current.id) + delta
      const next = current.siblings[index]
      return next ? [...prev.slice(0, -1), { ...current, id: next }] : prev
    })
  }, [])

  useEffect(() => {
    void sessionId
    setStack([])
  }, [sessionId])
  useEffect(() => {
    if (!isVisible) setStack([])
  }, [isVisible])

  const toolCall = top ? toolCalls.find((tc) => tc.toolCallId === top.id) : undefined
  const missing = top !== null && toolCall === undefined
  useEffect(() => {
    if (!missing) return
    log('warn', `Subagent ${top?.id.slice(0, 128)} left chat ${sessionId}; closed its panel`)
    setStack([])
  }, [missing, top, sessionId])

  const openId = top?.id ?? null
  const loggedId = useRef<string | null>(null)
  useEffect(() => {
    if (openId === loggedId.current) return
    loggedId.current = openId
    log(
      'info',
      openId
        ? `Showing subagent ${openId.slice(0, 128)} in chat ${sessionId}`
        : `Closed the subagent panel in chat ${sessionId}`
    )
  }, [openId, sessionId])

  useOverlayRegistration('subagent-panel', isMobile && toolCall !== undefined, close)

  const value = useMemo<SubagentSurface>(
    () => ({ sessionId, agentId, filePathContext, openId, opensDialog: !docked, open }),
    [sessionId, agentId, filePathContext, openId, docked, open]
  )

  let panel: ((sheet: boolean) => ReactNode) | null = null
  if (top && toolCall) {
    const parentTurn = subagentParentTurn(toolCall, lastUserBoundary(messages), turnActive)
    const index = top.siblings.indexOf(top.id)
    panel = (sheet) => (
      <SubagentPanel
        key={toolCall.toolCallId}
        toolCall={toolCall}
        status={subagentStatus(toolCall, parentTurn)}
        parentTurn={parentTurn}
        position={{ index: Math.max(0, index), total: Math.max(1, top.siblings.length) }}
        onBack={back}
        onClose={close}
        onStep={step}
        renderTitle={
          sheet
            ? (title) => (
                <SheetTitle className="truncate text-sm font-semibold text-foreground">
                  {title}
                </SheetTitle>
              )
            : undefined
        }
      />
    )
  }

  return (
    <SubagentSurfaceContext.Provider value={value}>
      <div ref={rootRef} className="flex h-full min-w-0">
        <div className="h-full min-w-0 flex-1">{children}</div>
        {docked && panel && (
          <aside
            aria-label="Subagent"
            className="h-full w-[clamp(20rem,38%,30rem)] shrink-0 border-l border-border bg-card"
          >
            {panel(false)}
          </aside>
        )}
      </div>
      {!docked && (
        <Sheet open={panel !== null} onOpenChange={(next) => !next && close()}>
          <SheetContent
            side={isMobile ? 'bottom' : 'right'}
            closeButton={false}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              // Focusing Back would pop its tooltip over the header.
              event.preventDefault()
              ;(event.currentTarget as HTMLElement | null)?.focus()
            }}
            onClick={(event) => {
              // A file link opened the editor, which the sheet would cover.
              const target = event.target as Element
              if (event.defaultPrevented && target.closest('[data-testid="termul-file-path"]')) {
                close()
              }
            }}
            className={
              isMobile
                ? 'flex h-[100dvh] max-h-[100dvh] flex-col gap-0 rounded-none bg-card p-0 pt-[env(safe-area-inset-top)]'
                : 'flex w-[min(30rem,90%)] flex-col gap-0 bg-card p-0 sm:max-w-none'
            }
          >
            {panel?.(true)}
          </SheetContent>
        </Sheet>
      )}
    </SubagentSurfaceContext.Provider>
  )
}
