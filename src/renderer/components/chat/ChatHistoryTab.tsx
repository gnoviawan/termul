import { type RefObject, useCallback, useId, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { ChatHistoryEntryRow } from './ChatHistoryEntryRow'
import { useChatHistoryEntries } from './use-chat-history-entries'

interface ChatHistoryTabProps {
  /** Optional callback after a chat row successfully opens (e.g. close a mobile drawer). */
  onSessionOpened?: () => void
  /** Title filter. The search field lives with the host (the mobile drawer), not in this tab. */
  query?: string
  /** Id of the host's History heading: the focus fallback after the last visible row is deleted. */
  historyHeadingId?: string
  /** Scroll container the lazy-load observer watches. Defaults to the viewport. */
  scrollRootRef?: RefObject<HTMLElement | null>
}

interface ChatDeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chat's title, named in the description. */
  title: string
  onConfirm: () => void
  /** Places focus once the dialog has closed (there is no Radix trigger to return to). */
  onClosed: () => void
}

/**
 * The chat history delete confirm, shared by the desktop sidebar and the mobile
 * Recents list. Nothing is deleted until its Delete.
 */
export function ChatDeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
  onClosed
}: ChatDeleteConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          // Radix would restore focus to the trigger; there is none (the row's
          // trash button opens this programmatically), so place it ourselves.
          event.preventDefault()
          onClosed()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete chat</AlertDialogTitle>
          <AlertDialogDescription>
            {`Delete “${title}”? This action cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90"
            onClick={onConfirm}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Sidebar tab listing persisted Termul-created chat sessions, grouped by recency; filtered by `query`. */
export function ChatHistoryTab({
  onSessionOpened,
  query = '',
  historyHeadingId,
  scrollRootRef
}: ChatHistoryTabProps = {}): React.JSX.Element {
  const {
    mergedEntries,
    filtered,
    visible,
    groups,
    hasMore,
    sentinelRef,
    loadMore,
    openEntry: handleOpen,
    deleteEntry: handleDelete
  } = useChatHistoryEntries({ query, scrollRootRef, onSessionOpened })

  const baseId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  // Delete confirm. The trash button only requests it; nothing is deleted
  // until the AlertDialog's Delete. `deleteTarget` outlives `deleteOpen` so the
  // description does not blank out while the dialog animates closed.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Where focus goes when the dialog closes: set when it opens (Cancel / Esc →
  // that row's trash button) and again on confirm (→ the next visible row).
  const closeFocusRef = useRef<() => void>(() => {})
  // The confirm's Delete stays tappable while the dialog animates closed, so a
  // quick second tap would delete the same session twice (the second rejects
  // and toasts a false "Could not delete"). Cleared each time a confirm opens.
  const confirmedDeleteIdRef = useRef<string | null>(null)

  const rowElements = useCallback(
    (): HTMLElement[] =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-history-entry-id]') ?? []),
    []
  )

  const focusRowButton = useCallback(
    (id: string, button: 'open' | 'delete'): boolean => {
      const row = rowElements().find((el) => el.dataset.historyEntryId === id)
      const target = row?.querySelector<HTMLElement>(`[data-history-${button}]`)
      if (!target) return false
      target.focus()
      return true
    },
    [rowElements]
  )

  // Last-resort focus target once no row can take it (the deleted chat was the
  // last visible one): the host's History heading, else this tab's own root,
  // which stays mounted (and programmatically focusable) so focus is never lost.
  const focusFallback = useCallback((): void => {
    const heading = historyHeadingId ? document.getElementById(historyHeadingId) : null
    const target = heading ?? rootRef.current
    target?.focus()
  }, [historyHeadingId])

  const requestDelete = useCallback(
    (id: string) => {
      const title = mergedEntries.find((e) => e.id === id)?.title ?? ''
      setDeleteTarget({ id, title })
      setDeleteOpen(true)
      confirmedDeleteIdRef.current = null
      closeFocusRef.current = () => {
        if (!focusRowButton(id, 'delete')) focusFallback()
      }
    },
    [mergedEntries, focusRowButton, focusFallback]
  )

  const confirmDelete = useCallback(() => {
    if (!deleteTarget || confirmedDeleteIdRef.current === deleteTarget.id) return
    const { id } = deleteTarget
    confirmedDeleteIdRef.current = id
    const rows = rowElements()
    const index = rows.findIndex((el) => el.dataset.historyEntryId === id)
    const nextId = index >= 0 ? rows[index + 1]?.dataset.historyEntryId : undefined
    closeFocusRef.current = () => {
      if (!nextId || !focusRowButton(nextId, 'open')) focusFallback()
    }
    handleDelete(id)
  }, [deleteTarget, rowElements, focusRowButton, focusFallback, handleDelete])

  return (
    <div ref={rootRef} tabIndex={-1} className="@container flex flex-col outline-none">
      <div className="py-1">
        {mergedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground">
            No chats yet. Start one with the New chat button.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No chats match this search.
          </div>
        ) : (
          groups.map(({ group, entries }) => {
            const labelId = `${baseId}-${group}`
            return (
              <div key={group}>
                <h3 id={labelId} className="label-group px-3 py-1 text-muted-foreground">
                  {group}
                </h3>
                <div role="group" aria-labelledby={labelId}>
                  {entries.map((entry) => (
                    <ChatHistoryEntryRow
                      key={entry.id}
                      entry={entry}
                      onOpen={(e) => void handleOpen(e)}
                      onDelete={requestDelete}
                    />
                  ))}
                </div>
              </div>
            )
          })
        )}
        {hasMore && (
          <div ref={sentinelRef} className="px-3 py-2">
            <button
              type="button"
              onClick={loadMore}
              className="min-h-11 w-full rounded-md py-1 text-xs tabular-nums text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03]"
            >
              Load more ({filtered.length - visible.length} more)
            </button>
          </div>
        )}
      </div>

      <ChatDeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={deleteTarget?.title ?? ''}
        onConfirm={confirmDelete}
        onClosed={() => closeFocusRef.current()}
      />
    </div>
  )
}
