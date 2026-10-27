import type React from 'react'
import { useEffect, useId, useSyncExternalStore } from 'react'
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
 * The pending confirmation lives in this module, not in the component that
 * asked for it, and is rendered by `ExternalLinkConfirmHost`, which the app
 * mounts once at its root. A link inside a streaming agent message is
 * re-rendered (or remounted) as text arrives; the dialog must not go with it.
 *
 * Only one confirmation can be pending app-wide, so a fast double click (or
 * two surfaces reacting to the same click) shows a single dialog, and a
 * confirmation opens its URL at most once however often "Open" is clicked.
 */

interface ExternalLinkRequest {
  id: number
  url: string
  /** Where focus goes back to when the dialog closes, if still in the page. */
  returnFocusTo: HTMLElement | null
  /** How to find an equivalent element if `returnFocusTo` was re-rendered away. */
  focusLocator: FocusLocator | null
}

/**
 * Enough about the trigger to find its stand-in after a remount. A link in a
 * streaming message can be replaced by an identical new node while the dialog
 * is open; focus should land on that node, not fall back to `<body>`.
 */
interface FocusLocator {
  /** The trigger's `href` attribute, when it is a link. */
  href: string | null
  /** The closest `[data-external-link-scope]` (a message, a thought, a panel). */
  scope: Element | null
  /** Position among same-href links inside `scope`, or the document. */
  index: number
  /** The trigger's ancestors, nearest first, for when no equivalent link is left. */
  ancestors: HTMLElement[]
}

interface ExternalLinkConfirmState {
  /** The confirmation awaiting an answer, or null. */
  pending: ExternalLinkRequest | null
  /** The latest request, kept after it settles for the exit animation and focus return. */
  last: ExternalLinkRequest | null
  /** The mounted host that renders the dialog (the first one mounted). */
  activeHost: string | null
}

let state: ExternalLinkConfirmState = { pending: null, last: null, activeHost: null }
let nextId = 1
const hosts: string[] = []
const listeners = new Set<() => void>()

/** Merge `next` into the store and notify every subscribed host. */
function setState(next: Partial<ExternalLinkConfirmState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore` subscription to the confirmation store. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface ExternalLinkRequestOptions {
  /** The element that triggered the request; it gets focus back on close. */
  returnFocusTo?: HTMLElement | null
}

/**
 * Ask the user to confirm opening `url` in the system browser. Returns false
 * (and asks nothing) when the URL is empty, another confirmation is pending,
 * or no `ExternalLinkConfirmHost` is mounted: without a host nobody could
 * answer, and opening unasked is exactly what this module exists to prevent.
 */
export function requestExternalLinkOpen(
  url: string | null | undefined,
  options: ExternalLinkRequestOptions = {}
): boolean {
  if (!url || state.pending !== null || state.activeHost === null) return false
  const request: ExternalLinkRequest = {
    id: nextId++,
    url,
    returnFocusTo: options.returnFocusTo ?? null,
    focusLocator: options.returnFocusTo ? locate(options.returnFocusTo) : null
  }
  setState({ pending: request, last: request })
  return true
}

/** Answer the pending confirmation. Idempotent: a settled request opens nothing. */
function settle(id: number, open: boolean): void {
  const { pending } = state
  if (pending === null || pending.id !== id) return
  setState({ pending: null })
  if (open) void openerApi.openUrlWithSystemBrowser(pending.url)
}

/** Marks a container (message, thought, panel) that scopes link lookups. */
const EXTERNAL_LINK_SCOPE_ATTR = 'data-external-link-scope'
const SCOPE_SELECTOR = `[${EXTERNAL_LINK_SCOPE_ATTR}]`

/** Links under `root` whose `href` attribute is exactly `href`, in document order. */
function linksTo(root: ParentNode, href: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('a[href]')).filter(
    (anchor) => anchor.getAttribute('href') === href
  )
}

/** Snapshot of where the trigger sits, taken when the confirmation is requested. */
function locate(target: HTMLElement): FocusLocator {
  const href = target.tagName === 'A' ? target.getAttribute('href') : null
  const scope = target.closest(SCOPE_SELECTOR)
  const index = href === null ? -1 : linksTo(scope ?? document, href).indexOf(target)
  const ancestors: HTMLElement[] = []
  for (let node = target.parentElement; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break
    ancestors.push(node)
  }
  return { href, scope, index, ancestors }
}

/** Focus `element`; true if it (or, for an editor link, its editor) took focus. */
function tryFocus(element: HTMLElement | null | undefined): boolean {
  if (!element?.isConnected) return false
  element.focus({ preventScroll: true })
  if (document.activeElement === element) return true
  // A link inside an editor is not focusable on its own; focus the editor.
  const editable = element.closest<HTMLElement>('[contenteditable="true"]')
  editable?.focus({ preventScroll: true })
  return editable !== null && document.activeElement === editable
}

/** The link that now stands where the trigger stood: same href, same scope, same position. */
function equivalentLink(locator: FocusLocator): HTMLElement | undefined {
  if (locator.href === null) return undefined
  const scope = locator.scope?.isConnected ? locator.scope : document
  const links = linksTo(scope, locator.href)
  return links[locator.index] ?? links[0]
}

/** Focus a container that may not be focusable itself, without adding a tab stop. */
function focusContainer(container: HTMLElement): boolean {
  if (!container.isConnected) return false
  if (tryFocus(container)) return true
  if (container.hasAttribute('tabindex')) return false
  container.setAttribute('tabindex', '-1')
  container.addEventListener('blur', () => container.removeAttribute('tabindex'), { once: true })
  return tryFocus(container)
}

/**
 * Put focus back where the user was. In order: the trigger itself, an
 * equivalent link (the trigger re-rendered or remounted while the dialog was
 * open), then the nearest container of the trigger still in the page. Returns
 * false only when none of these is left, so the dialog's default applies.
 */
function returnFocus(request: ExternalLinkRequest): boolean {
  if (tryFocus(request.returnFocusTo)) return true
  const locator = request.focusLocator
  if (locator === null) return false
  if (tryFocus(equivalentLink(locator))) return true
  return locator.ancestors.some(focusContainer)
}

/**
 * Renders the app-wide link confirmation. Mount once at the app root, outside
 * any component that re-renders with content (chat messages, editors).
 */
export function ExternalLinkConfirmHost(): React.JSX.Element | null {
  const hostId = useId()
  useEffect(() => {
    hosts.push(hostId)
    if (state.activeHost === null) setState({ activeHost: hostId })
    return () => {
      hosts.splice(hosts.indexOf(hostId), 1)
      if (state.activeHost !== hostId) return
      const successor = hosts[0] ?? null
      // Nobody is left to answer: drop the request rather than leave it stuck.
      setState(successor === null ? { activeHost: null, pending: null } : { activeHost: successor })
    }
  }, [hostId])

  const snapshot = useSyncExternalStore(subscribe, () => state)
  if (snapshot.activeHost !== hostId || snapshot.last === null) return null
  const request = snapshot.last
  return (
    <ExternalLinkConfirmDialog
      open={snapshot.pending?.id === request.id}
      url={request.url}
      onCancel={() => settle(request.id, false)}
      onConfirm={() => settle(request.id, true)}
      onCloseAutoFocus={(event) => {
        if (returnFocus(request)) event.preventDefault()
      }}
    />
  )
}

/**
 * The confirmation dialog itself, controlled by its host. "Open" calls
 * `onConfirm`; Cancel, Escape and an outside click call `onCancel`.
 */
export function ExternalLinkConfirmDialog({
  open,
  url,
  onCancel,
  onConfirm,
  onCloseAutoFocus
}: {
  open: boolean
  url: string
  onCancel: () => void
  onConfirm: () => void
  onCloseAutoFocus?: (event: Event) => void
}): React.JSX.Element {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto] overflow-hidden"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Open external link?</AlertDialogTitle>
          {/* Long URLs scroll here so Cancel / Open always stay on screen. */}
          <AlertDialogDescription
            data-external-link-url=""
            className="max-h-40 overflow-y-auto break-all [overflow-wrap:anywhere] font-mono text-xs"
          >
            {url}
          </AlertDialogDescription>
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

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Click / auxclick handler for a container of rendered (sanitized) HTML. Any
 * link click inside is stopped before it can navigate the webview or reach the
 * Tauri opener plugin, and absolute URLs go through the confirmation instead.
 * Relative and `#` links are only stopped: there is nothing external to open.
 */
export function handleExternalLinkClick(event: React.MouseEvent<HTMLElement>): void {
  if (!(event.target instanceof Element)) return
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor || !event.currentTarget.contains(anchor)) return
  event.preventDefault()
  if (event.type !== 'click' || event.button !== 0) return
  const href = anchor.getAttribute('href') ?? ''
  if (HAS_SCHEME.test(href)) requestExternalLinkOpen(href, { returnFocusTo: anchor })
}

/**
 * Scroll to the element a `#fragment` link points at, looked up inside the
 * link's `[data-external-link-scope]` (its message or thought), so ids repeated
 * across messages, such as footnotes, resolve locally. A fragment link is
 * in-page: it never asks for confirmation and never opens a browser.
 */
function scrollToFragment(link: HTMLElement, href: string): void {
  let id = href.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    // Keep the raw fragment.
  }
  if (!id) return
  const root = link.closest(SCOPE_SELECTOR) ?? document
  const target = Array.from(root.querySelectorAll('[id]')).find((element) => element.id === id)
  target?.scrollIntoView({ block: 'start' })
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
  return (
    <a
      {...props}
      href={href}
      rel="noreferrer"
      className={cn(className)}
      onClick={(event) => {
        event.preventDefault()
        if (href?.startsWith('#')) {
          scrollToFragment(event.currentTarget, href)
          return
        }
        requestExternalLinkOpen(href, { returnFocusTo: event.currentTarget })
      }}
      onAuxClick={(event) => {
        event.preventDefault()
      }}
    >
      {children}
    </a>
  )
}
