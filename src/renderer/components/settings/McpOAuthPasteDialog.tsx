/**
 * Web MCP OAuth paste-back (spec-mcp-oauth-web-paste-back).
 *
 * The host registers a loopback redirect (`http://127.0.0.1:{port}/oauth/callback`).
 * A browser on the host's machine reaches it and the host finishes on its own;
 * the running `connectMcpOAuth` poll then sees the token and this dialog
 * closes. A browser anywhere else lands on a page that cannot load: the user
 * pastes that address here and the host exchanges the code with the session
 * it kept from the start. Mounted once by each root (`App.tsx`, `TauriApp.tsx`)
 * so both Connect entry points (MCP settings, catalog install) share it; on
 * desktop it renders nothing, because desktop never sets `mcpOAuthPasteBack`.
 */

import { useId, useState } from 'react'
import { toast } from 'sonner'
import { isLoopbackAuthRedirectUrl } from '@/components/agents/BrowserAuthDialog'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { McpOAuthError } from '@/lib/acp-api'
import { openerApi } from '@/lib/api'
import { type McpOAuthPasteBack, useAcpStore } from '@/stores/acp-store'

interface PasteError {
  message: string
  /** The host dropped the flow, so pasting again cannot succeed. */
  final: boolean
}

/** What the dialog shows for a failed paste; `null` = the flow is gone and
 * the dialog closes (the store already cancelled it). */
function pasteErrorFor(err: unknown, redirectUri: string): PasteError | null {
  const code = err instanceof McpOAuthError ? err.code : ''
  const detail = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'OAUTH_UNKNOWN_STATE':
      return null
    case 'OAUTH_BAD_REDIRECT':
      return {
        message: `That address does not belong to this sign-in. Paste the full address that starts with ${redirectUri}.`,
        final: false
      }
    case 'OAUTH_DENIED':
      return {
        message: `Sign-in was not allowed (${detail}). Dismiss, then press Connect to try again.`,
        final: true
      }
    case 'OAUTH_EXCHANGE_FAILED':
      return {
        message: `Troupe could not finish signing in (${detail}). Dismiss, then press Connect to try again.`,
        final: true
      }
    default:
      return { message: detail || 'Could not reach Troupe. Try again.', final: false }
  }
}

export function McpOAuthPasteDialog({
  serverId,
  pending
}: {
  serverId: string
  pending: McpOAuthPasteBack
}): React.JSX.Element {
  const completeMcpOAuthPaste = useAcpStore((s) => s.completeMcpOAuthPaste)
  const cancelMcpOAuth = useAcpStore((s) => s.cancelMcpOAuth)
  const [pastedUrl, setPastedUrl] = useState('')
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState<PasteError | null>(null)
  const inputId = useId()
  const { authUrl, redirectUri, serverName } = pending

  // While a paste is in flight the host may be storing the token, so the
  // flow must not be cancelled under it.
  const dismiss = (): void => {
    if (!completing) cancelMcpOAuth(serverId)
  }

  const handleOpen = (): void => {
    void openerApi.openUrlWithSystemBrowser(authUrl).then((result) => {
      if (!result.success) toast.error('The sign-in page did not open. Use Copy instead.')
    })
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(authUrl)
      toast.success('Sign-in link copied')
    } catch {
      toast.error('Could not copy the sign-in link.')
    }
  }

  const handleComplete = async (): Promise<void> => {
    const trimmed = pastedUrl.trim()
    if (!isLoopbackAuthRedirectUrl(trimmed)) {
      setError({
        message: `Paste the address your browser landed on. It starts with ${redirectUri}.`,
        final: false
      })
      return
    }
    setCompleting(true)
    setError(null)
    try {
      // On success the store clears this entry and the dialog unmounts; the
      // running Connect then reports the server connected.
      await completeMcpOAuthPaste(serverId, trimmed)
    } catch (err) {
      const next = pasteErrorFor(err, redirectUri)
      if (next === null) {
        toast.error(`The sign-in to ${serverName} expired. Press Connect to start again.`)
        return
      }
      setError(next)
      setCompleting(false)
    }
  }

  const canComplete = !completing && !error?.final && pastedUrl.trim().length > 0

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Finish signing in to ${serverName}`}</DialogTitle>
          <DialogDescription>
            Sign in on the page that opened. If it did not open, use Open or Copy below. When your
            browser then lands on a 127.0.0.1 address that fails to load or shows an error, paste
            that address here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            {authUrl}
          </code>
          <Button type="button" size="sm" variant="outline" onClick={handleOpen}>
            Open
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()}>
            Copy
          </Button>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={inputId} className="text-xs font-medium text-foreground/85">
            Paste the redirect address
          </label>
          <Input
            id={inputId}
            value={pastedUrl}
            onChange={(e) => setPastedUrl(e.target.value)}
            placeholder={`${redirectUri}?code=…`}
            spellCheck={false}
            autoComplete="off"
            disabled={error?.final}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canComplete) void handleComplete()
            }}
          />
          <p className="text-xs text-muted-foreground">
            A browser on the same machine as Troupe finishes by itself, and this dialog closes.
          </p>
        </div>

        {error && (
          <SettingsNotice tone="danger" role="alert">
            {error.message}
          </SettingsNotice>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={completing} onClick={dismiss}>
            Dismiss
          </Button>
          <Button type="button" disabled={!canComplete} onClick={() => void handleComplete()}>
            {completing ? 'Completing…' : 'Complete sign-in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Global mount point: one dialog per MCP server whose web OAuth flow is
 * waiting on its sign-in. */
export function McpOAuthPasteDialogHost(): React.JSX.Element {
  const pasteBack = useAcpStore((s) => s.mcpOAuthPasteBack)
  return (
    <>
      {Object.entries(pasteBack).map(([serverId, pending]) => (
        <McpOAuthPasteDialog
          key={`${serverId}:${pending.authUrl}`}
          serverId={serverId}
          pending={pending}
        />
      ))}
    </>
  )
}
