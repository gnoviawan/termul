import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Edit2, GitBranch, Globe, Pencil, TerminalSquare, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { sectionForTab } from '@/hooks/use-mobile-section'
import { useMobileTabActions } from '@/hooks/use-mobile-tab-actions'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'

/** Inline row actions (close, rename) hold the 44px touch floor. */
const INLINE_ACTION_BUTTON = 'size-11 shrink-0 rounded-full'

/**
 * Claude-style row select button: borderless 16px label, the active row a
 * full-width pill. `min-w-0` lets the button shrink below its content width —
 * without it a long title pins the row wider than the drawer and pushes the ×
 * button off-screen.
 */
function rowButtonClass(isActive: boolean): string {
  return cn(
    'h-auto min-h-11 min-w-0 flex-1 justify-start gap-3 rounded-full px-4 py-2 text-base font-normal',
    isActive ? 'bg-secondary text-foreground' : 'text-foreground'
  )
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

/**
 * Where focus goes once the control the user pressed is gone (L-18). A closed
 * row takes its X with it, and a rename input takes itself, so without this
 * focus falls to `<body>` inside the drawer's focus trap. Registered before the
 * action, resolved in a layout effect once the row (or the input) is gone.
 */
type PendingFocus =
  | { kind: 'removal'; rowId: string; nextRowId: string | null }
  | { kind: 'rename'; terminalId: string }

/** True when focus has fallen to `<body>` (or to something no longer attached). */
function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/** Focus the first candidate that really takes it (a hidden or non-focusable one does not). */
function focusFirst(candidates: Array<HTMLElement | null | undefined>): boolean {
  for (const element of candidates) {
    if (!element?.isConnected) continue
    element.focus()
    if (document.activeElement === element) return true
  }
  return false
}

/** The `[attribute]` element of `root` whose attribute value is exactly `value`. */
function findByDataValue(
  root: HTMLElement | null,
  attribute: string,
  value: string
): HTMLElement | null {
  const matches = root?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []
  return Array.from(matches).find((element) => element.getAttribute(attribute) === value) ?? null
}

/** Every tab the Editors list shows (a stray canvas tab included, for exhaustiveness). */
type EditorKindTab = Extract<WorkspaceTab, { type: 'editor' | 'git' | 'browser' | 'canvas' }>

/** An Editors row's label (also the name of its close button). */
function editorTabLabel(
  tab: EditorKindTab,
  browserLabel: (browserTabId: string) => string
): string {
  switch (tab.type) {
    case 'editor':
      return basename(tab.filePath) || 'editor tab'
    case 'git':
      return 'Git Changes'
    case 'browser':
      return browserLabel(tab.browserTabId)
    case 'canvas':
      return basename(tab.docPath)
    default: {
      // Exhaustiveness guard (as in WorkspaceTabBar): a new tab kind fails to
      // compile here instead of rendering a blank row.
      const unhandledTab: never = tab
      void unhandledTab
      return 'Tab'
    }
  }
}

function isEditorKindTab(tab: WorkspaceTab): tab is EditorKindTab {
  return sectionForTab(tab) === 'editors'
}

interface MobileDrawerSectionListProps {
  /** Which section's open tabs to list. */
  section: 'terminals' | 'editors'
  /** Id of the drawer's section heading: labels the group, and the focus fallback. */
  headingId: string
  /** The active pane's active tab id: that row is `aria-current="page"`. */
  activeTabId: string | null
  /** A row navigated: the drawer closes (and moves focus to the destination). */
  onNavigate: () => void
  /** Returns `true` only when the close opened a confirm (see `onConfirmOpened`). */
  onCloseTerminal?: (terminalId: string, tabId: string) => boolean
  onRenameTerminal?: (terminalId: string, name: string) => void
  /** Close an editor tab through the dirty-file guard. Returns `true` only when it opened the confirm. */
  onCloseEditorTab?: (filePath: string) => boolean
  /**
   * `onCloseTerminal` or `onCloseEditorTab` opened a confirm. The drawer hands
   * off to it: it closes, so the confirm is not covered by the drawer's overlay.
   */
  onConfirmOpened?: () => void
}

/**
 * The drawer's contextual list for the Terminals and Editors sections: the
 * open tabs of that kind, each with a guarded close (terminals also rename
 * inline). On mobile the WorkspaceTabBar is hidden, so these rows are how a
 * tab is reached and closed.
 */
export function MobileDrawerSectionList({
  section,
  headingId,
  activeTabId,
  onNavigate,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  onConfirmOpened
}: MobileDrawerSectionListProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingFocusRef = useRef<PendingFocus | null>(null)
  // Set when a rename ends; the input's own blur (fired when it unmounts) must
  // not commit a second time, nor undo an Escape.
  const renameEndedRef = useRef(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const { paneTabs, selectTab, closePaneTab } = useMobileTabActions({
    onCloseTerminal,
    onCloseEditorTab
  })

  const terminalTabs = useMemo(
    () => paneTabs.flatMap(({ tab, paneId }) => (tab.type === 'terminal' ? [{ tab, paneId }] : [])),
    [paneTabs]
  )
  const editorTabs = useMemo(
    () => paneTabs.flatMap(({ tab, paneId }) => (isEditorKindTab(tab) ? [{ tab, paneId }] : [])),
    [paneTabs]
  )

  const terminals = useTerminalStore((s) => s.terminals)

  // Editor dirty state for the dirty dots. Subscribe to the whole openFiles map
  // reference (stable unless a file opens/closes) and resolve dirtiness
  // per-row — zustand's set() always produces a new Map, so this re-renders
  // exactly when openFiles changes.
  const openFiles = useEditorStore((s) => s.openFiles)
  const isEditorFileDirty = (filePath: string): boolean => openFiles.get(filePath)?.isDirty ?? false

  // Canvas dirty state, the same way: one canvas session per project.
  const canvasSessions = useCanvasStore((s) => s.sessions)
  const isCanvasDirty = (projectId: string): boolean => canvasSessions[projectId]?.dirty ?? false

  // Browser tab labels (title → host → 'Browser'), mirroring WorkspaceTabBar.
  const browserTabs = useBrowserSessionStore((s) => s.tabs)
  const browserLabel = (browserTabId: string): string => {
    const t = browserTabs.get(browserTabId)
    if (t?.title.trim()) return t.title.trim()
    if (t?.url) {
      try {
        const parsed = new URL(t.url)
        return parsed.host || parsed.hostname || t.url
      } catch {
        return t.url.replace(/^https?:\/\//, '').split('/')[0] || 'Browser'
      }
    }
    return 'Browser'
  }

  const rowIds = (section === 'terminals' ? terminalTabs : editorTabs).map(({ tab }) => tab.id)

  // L-18: after a row is gone (or a rename ends) focus would fall to <body>
  // inside the drawer's focus trap: the next row's select button, else the
  // section heading, else this list's root, which stays mounted and
  // programmatically focusable. Only when focus really was lost: a user who
  // moved focus meanwhile keeps it, and a close that has not completed (a kill
  // that failed) leaves the row, and focus, alone.
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    if (pending.kind === 'removal') {
      if (rowIds.includes(pending.rowId)) return
    } else if (renamingId === pending.terminalId) {
      return
    }
    pendingFocusRef.current = null
    if (!focusIsLost()) return
    const root = rootRef.current
    const candidates =
      pending.kind === 'rename'
        ? [findByDataValue(root, 'data-section-rename', pending.terminalId)]
        : [
            pending.nextRowId
              ? findByDataValue(root, 'data-section-row-select', pending.nextRowId)
              : null,
            document.getElementById(headingId),
            root
          ]
    if (!focusFirst(candidates)) {
      void logFrontendError({
        level: 'info',
        source: 'MobileDrawerSectionList.focus',
        message: `Section row ${pending.kind === 'rename' ? 'rename ended' : 'closed'} with no connected focus target`
      })
    }
  })

  const closeRow = (tab: WorkspaceTab): void => {
    const index = rowIds.indexOf(tab.id)
    pendingFocusRef.current = {
      kind: 'removal',
      rowId: tab.id,
      nextRowId: (index >= 0 ? rowIds[index + 1] : undefined) ?? null
    }
    if (closePaneTab(tab)) {
      // The drawer closes under the confirm: nothing left here to focus.
      pendingFocusRef.current = null
      onConfirmOpened?.()
    }
  }

  const choose = (paneId: string, tabId: string): void => {
    selectTab(paneId, tabId)
    onNavigate()
  }

  const startRename = (terminalId: string, currentName: string): void => {
    renameEndedRef.current = false
    setRenamingId(terminalId)
    setRenameValue(currentName)
  }

  // Enter and Escape end a rename on purpose, so focus returns to that row's
  // Rename button; a blur (the user moved on) commits without moving focus.
  const endRename = (outcome: 'commit' | 'cancel', focus: 'rename-button' | 'leave'): void => {
    if (renameEndedRef.current) return
    renameEndedRef.current = true
    if (focus === 'rename-button' && renamingId) {
      pendingFocusRef.current = { kind: 'rename', terminalId: renamingId }
    }
    if (outcome === 'commit' && renamingId && renameValue.trim() && onRenameTerminal) {
      onRenameTerminal(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }

  if (section === 'terminals') {
    return (
      <div ref={rootRef} tabIndex={-1} className="px-2 pb-2 outline-none">
        {terminalTabs.length === 0 ? (
          <p className="px-4 py-2 text-sm text-muted-foreground">No open terminals</p>
        ) : (
          <div role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5">
            {terminalTabs.map(({ tab, paneId }) => {
              const terminalName = terminals.find((item) => item.id === tab.terminalId)?.name
              const name = terminalName ?? 'terminal'
              const isActive = tab.id === activeTabId
              const isRenaming = renamingId === tab.terminalId
              return (
                <div key={tab.id} className="flex min-w-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className={rowButtonClass(isActive)}
                    aria-current={isActive ? 'page' : undefined}
                    data-section-row-select={tab.id}
                    onClick={() => choose(paneId, tab.id)}
                  >
                    <TerminalSquare size={16} />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {terminalName ?? 'Terminal'}
                    </span>
                  </Button>
                  {isRenaming ? (
                    <input
                      type="text"
                      value={renameValue}
                      aria-label={`Rename ${name}`}
                      data-section-rename-input=""
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => endRename('commit', 'leave')}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== 'Escape') return
                        // Focus moves to the Rename button inside this very
                        // keydown. Left alone, the browser then fires the key's
                        // keypress on that button, and Enter on a button clicks
                        // it: the field would reopen as soon as it closed.
                        // Cancelling the keydown suppresses the keypress.
                        e.preventDefault()
                        endRename(e.key === 'Enter' ? 'commit' : 'cancel', 'rename-button')
                      }}
                      className="min-h-11 w-28 shrink-0 rounded-md border border-border bg-background px-2 text-base"
                      autoFocus
                    />
                  ) : (
                    onRenameTerminal && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={INLINE_ACTION_BUTTON}
                        aria-label={`Rename ${name}`}
                        data-section-rename={tab.terminalId}
                        onClick={() => startRename(tab.terminalId, terminalName ?? 'Terminal')}
                      >
                        <Pencil size={14} />
                      </Button>
                    )
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={INLINE_ACTION_BUTTON}
                    aria-label={`Close ${name}`}
                    onClick={() => closeRow(tab)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="px-2 pb-2 outline-none">
      {editorTabs.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">No open editors</p>
      ) : (
        <div role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5">
          {editorTabs.map(({ tab, paneId }) => {
            const isActive = tab.id === activeTabId
            const rowLabel = editorTabLabel(tab, browserLabel)
            const dirty =
              (tab.type === 'editor' && isEditorFileDirty(tab.filePath)) ||
              (tab.type === 'canvas' && isCanvasDirty(tab.projectId))
            return (
              <div key={tab.id} className="flex min-w-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  className={rowButtonClass(isActive)}
                  aria-current={isActive ? 'page' : undefined}
                  data-section-row-select={tab.id}
                  onClick={() => choose(paneId, tab.id)}
                >
                  {tab.type === 'editor' && <Pencil size={16} />}
                  {tab.type === 'git' && <GitBranch size={16} />}
                  {tab.type === 'browser' && <Globe size={16} />}
                  {tab.type === 'canvas' && <Edit2 size={16} />}
                  <span className="min-w-0 flex-1 truncate text-left">{rowLabel}</span>
                  {dirty && (
                    <>
                      <span
                        data-testid={
                          tab.type === 'canvas' ? 'canvas-dirty-dot' : 'editor-dirty-dot'
                        }
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-primary-fill"
                      />
                      <span className="sr-only">, unsaved changes</span>
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={INLINE_ACTION_BUTTON}
                  aria-label={`Close ${rowLabel}`}
                  onClick={() => closeRow(tab)}
                >
                  <X size={14} />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
