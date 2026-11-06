/**
 * "Share to chat" for a user browser tab: the toolbar button, the in-pane
 * consent strip, and the "shared" indicator with one-action stop.
 *
 * The decision lives in the main webview's DOM, so page JS cannot click it
 * (native child webviews paint above DOM, which is why this docks in the pane
 * like `BrowserConsentStrip`). The Share button arms a moment after the strip
 * or its origin changes, so a click aimed at something that just moved under
 * the pointer cannot share. Agent-controlled tabs get no share affordance:
 * this only grants read access to a tab the user opened.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConsentArmed } from '@/components/browser/consent-intent'
import { Globe, MessageSquarePlus, ShieldAlert } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentDisplayName } from '@/hooks/use-agent-display-name'
import { useInterfaceOverlayOpen } from '@/hooks/use-native-webview-occlusion'
import { isUserBrowserTabId } from '@/lib/browser-api'
import {
  BROWSER_SHARE_SCOPES,
  type BrowserShareErrorCode,
  type BrowserShareScope,
  browserShareCreate,
  browserShareOriginOf,
  DEFAULT_BROWSER_SHARE_SCOPES
} from '@/lib/browser-share-api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import {
  retainBrowserShareSync,
  selectTabActiveShares,
  useBrowserShareStore
} from '@/stores/browser-share-store'
import {
  BROWSER_SHARE_LIFETIME_NOTE,
  BROWSER_SHARE_NETWORK_NOTE,
  BROWSER_SHARE_SCREENSHOT_WARNING,
  browserShareErrorMessage,
  browserShareScopeDetail,
  browserShareScopeLabel,
  browserShareScopeSummary
} from './share-copy'

function canShareTab(tabId: string): boolean {
  return isTauriContext() && isUserBrowserTabId(tabId)
}

function useShareSync(enabled: boolean): void {
  useEffect(() => (enabled ? retainBrowserShareSync() : undefined), [enabled])
}

/** Toolbar button that opens the consent strip for this tab. */
export function BrowserShareButton({
  browserTabId
}: {
  browserTabId: string
}): React.JSX.Element | null {
  const open = useBrowserShareStore((s) => s.consentTabId === browserTabId)
  const openConsent = useBrowserShareStore((s) => s.openConsent)
  const closeConsent = useBrowserShareStore((s) => s.closeConsent)
  if (!canShareTab(browserTabId)) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => (open ? closeConsent() : openConsent(browserTabId))}
          aria-pressed={open}
          aria-label="Share this page to chat"
          className="p-1.5 rounded shrink-0 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <MessageSquarePlus size={14} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Share to chat</TooltipContent>
    </Tooltip>
  )
}

/** Consent strip while the button is open, else the "shared" indicator. */
export function BrowserShareStrip({
  browserTabId
}: {
  browserTabId: string
}): React.JSX.Element | null {
  const enabled = canShareTab(browserTabId)
  useShareSync(enabled)
  const overlayOpen = useInterfaceOverlayOpen()
  const consentOpen = useBrowserShareStore((s) => s.consentTabId === browserTabId)
  if (!enabled || overlayOpen) return null
  return consentOpen ? (
    <BrowserShareConsent browserTabId={browserTabId} />
  ) : (
    <BrowserShareIndicator browserTabId={browserTabId} />
  )
}

function BrowserShareIndicator({
  browserTabId
}: {
  browserTabId: string
}): React.JSX.Element | null {
  const shares = useBrowserShareStore(useShallow((s) => selectTabActiveShares(s, browserTabId)))
  const revoking = useBrowserShareStore((s) => s.revoking)
  const pending = useBrowserShareStore((s) => s.pending)
  const revoke = useBrowserShareStore((s) => s.revoke)
  const [failed, setFailed] = useState(false)
  if (shares.length === 0) return null
  const label = shares.some((share) => !pending[share.shareId])
    ? 'Shared with chat'
    : 'Ready to share with chat'
  const scopes = BROWSER_SHARE_SCOPES.filter((scope) =>
    shares.some((share) => share.scopes.includes(scope))
  )
  const busy = shares.some((share) => revoking[share.shareId])
  const stopAll = async (): Promise<void> => {
    setFailed(false)
    const results = await Promise.all(shares.map((share) => revoke(share.shareId)))
    if (results.includes(false)) setFailed(true)
  }
  return (
    <section
      aria-label={label}
      className="flex shrink-0 items-center gap-2 border-l-2 border-primary border-b border-border bg-card px-3 py-1.5 text-2xs"
    >
      <MessageSquarePlus size={14} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{label}:</span>{' '}
        <span className="text-muted-foreground">{browserShareScopeSummary(scopes)}</span>
        {failed ? <span className="text-destructive"> · Could not stop. Try again.</span> : null}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => void stopAll()}
        className="shrink-0 text-2xs"
      >
        Stop sharing
      </Button>
    </section>
  )
}

function BrowserShareConsent({ browserTabId }: { browserTabId: string }): React.JSX.Element {
  const url = useBrowserSessionStore((s) => s.tabs.get(browserTabId)?.url ?? '')
  const origin = browserShareOriginOf(url)
  const session = useAcpStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined
  )
  const agentName = useAgentDisplayName(session?.agentId)
  const closeConsent = useBrowserShareStore((s) => s.closeConsent)
  const upsert = useBrowserShareStore((s) => s.upsert)
  const [scopes, setScopes] = useState<ReadonlySet<BrowserShareScope>>(
    () => new Set(DEFAULT_BROWSER_SHARE_SCOPES)
  )
  const [error, setError] = useState<BrowserShareErrorCode | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const armed = useConsentArmed(`share:${browserTabId}:${origin ?? ''}`)
  const mountedRef = useRef(true)
  useEffect(
    () => () => {
      mountedRef.current = false
    },
    []
  )

  const target =
    session && session.status !== 'closed' && session.status !== 'error' ? session : null
  const ordered = useMemo(() => BROWSER_SHARE_SCOPES.filter((s) => scopes.has(s)), [scopes])
  const canShare = armed && !submitting && !!origin && !!target && ordered.length > 0

  const toggle = (scope: BrowserShareScope, on: boolean): void => {
    setScopes((prev) => {
      const next = new Set(prev)
      if (on) next.add(scope)
      else next.delete(scope)
      return next
    })
  }

  const share = async (): Promise<void> => {
    if (!canShare || !origin || !target) return
    setSubmitting(true)
    setError(null)
    const result = await browserShareCreate({
      tabId: browserTabId,
      sessionId: target.id,
      scopes: ordered,
      expectedOrigin: origin
    })
    if (!mountedRef.current) return
    setSubmitting(false)
    if (!result.success) {
      setError(result.code)
      void logFrontendError({
        level: 'warn',
        message: `browser share create failed: code=${result.code}`,
        source: 'BrowserShareStrip'
      })
      return
    }
    upsert(result.data, { pending: true })
    void logFrontendError({
      level: 'info',
      message: `browser share created: scopes=${result.data.scopes.join(',')}`,
      source: 'BrowserShareStrip'
    })
    closeConsent()
  }

  return (
    <section
      aria-label="Share this page to chat"
      className="flex shrink-0 flex-col gap-1.5 border-l-2 border-warning border-b border-border bg-card px-3 py-2 text-2xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ShieldAlert size={14} className="shrink-0 text-warning" aria-hidden="true" />
        <span className="font-medium text-foreground">Share this page with the chat?</span>
        <span className="flex min-w-0 items-center gap-1 font-mono text-muted-foreground">
          <Globe size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{origin ?? 'This page cannot be shared'}</span>
        </span>
      </div>
      <span className="text-muted-foreground">
        {target
          ? `With ${agentName ?? 'the agent'}${target.title ? ` · ${target.title}` : ''}`
          : 'Open a chat first, then share this page to it.'}
      </span>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="sr-only">What to share</legend>
        {BROWSER_SHARE_SCOPES.map((scope) => (
          <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-foreground">
            <input
              type="checkbox"
              checked={scopes.has(scope)}
              onChange={(e) => toggle(scope, e.target.checked)}
              className="rounded border-border"
            />
            {browserShareScopeLabel(scope)}
            <span className="text-muted-foreground">— {browserShareScopeDetail(scope)}</span>
          </label>
        ))}
      </fieldset>
      {scopes.has('screenshot') ? (
        <p className="text-warning">{BROWSER_SHARE_SCREENSHOT_WARNING}</p>
      ) : null}
      {scopes.has('network_failures') ? (
        <p className="text-muted-foreground">{BROWSER_SHARE_NETWORK_NOTE}</p>
      ) : null}
      <p className="text-muted-foreground">{BROWSER_SHARE_LIFETIME_NOTE}</p>
      {error ? (
        <p role="alert" className="text-destructive">
          {browserShareErrorMessage(error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={closeConsent} className="text-2xs">
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          disabled={!canShare}
          onClick={() => void share()}
          className="text-2xs"
        >
          Share to chat
        </Button>
      </div>
    </section>
  )
}
