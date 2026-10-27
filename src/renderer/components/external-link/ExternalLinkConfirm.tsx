import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { openerApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The one way the renderer sends a URL to the system browser: ask first, open
 * only on an explicit "Open". Cancel, Escape and clicking outside open nothing.
 *
 * Only one confirmation can be pending app-wide, so a fast double click (or
 * two link surfaces reacting to the same click) shows a single dialog, and a
 * dialog opens the URL at most once even if "Open" is clicked repeatedly
 * during its exit animation.
 */
let pendingOwner: symbol | null = null

export interface ExternalLinkConfirm {
  /** Ask the user to confirm `url`. A no-op while any confirmation is pending. */
  requestOpen: (url: string) => void
  /** Render this once next to the links that call `requestOpen`. */
  dialog: React.JSX.Element | null
}

export function useExternalLinkConfirm(): ExternalLinkConfirm {
  const [url, setUrl] = useState<string | null>(null)
  const ownerRef = useRef<symbol>(Symbol('external-link-confirm'))
  const openedRef = useRef(false)

  const release = useCallback(() => {
    if (pendingOwner === ownerRef.current) pendingOwner = null
  }, [])

  const requestOpen = useCallback((next: string) => {
    if (!next || pendingOwner !== null) return
    pendingOwner = ownerRef.current
    openedRef.current = false
    setUrl(next)
  }, [])

  const close = useCallback(() => {
    release()
    setUrl(null)
  }, [release])

  const confirm = useCallback(() => {
    if (openedRef.current || url === null) return
    openedRef.current = true
    void openerApi.openUrlWithSystemBrowser(url)
    close()
  }, [url, close])

  useEffect(() => release, [release])

  const dialog =
    url === null ? null : (
      <ExternalLinkConfirmDialog url={url} onCancel={close} onConfirm={confirm} />
    )

  return { requestOpen, dialog }
}

export function ExternalLinkConfirmDialog({
  url,
  onCancel,
  onConfirm
}: {
  url: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open external link?</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{url}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            Open
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

type AnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement>

/**
 * A markdown link that never navigates or opens by itself. It deliberately has
 * no `target="_blank"`: the Tauri opener plugin's global click listener opens
 * any unprevented `_blank` anchor click straight away, which is how a link can
 * reach the browser while its confirmation is still on screen.
 */
export function ConfirmedExternalLink({
  href,
  className,
  children,
  target: _target,
  rel: _rel,
  onClick: _onClick,
  onAuxClick: _onAuxClick,
  ...props
}: AnchorProps): React.JSX.Element {
  const { requestOpen, dialog } = useExternalLinkConfirm()
  return (
    <>
      <a
        {...props}
        href={href}
        rel="noreferrer"
        className={cn(className)}
        onClick={(event) => {
          event.preventDefault()
          if (href) requestOpen(href)
        }}
        onAuxClick={(event) => {
          event.preventDefault()
        }}
      >
        {children}
      </a>
      {dialog}
    </>
  )
}
