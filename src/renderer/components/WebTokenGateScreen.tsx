/**
 * Web auth token-entry screen (issue #854).
 *
 * On a token-gated `termul-server`, opening the web client without a token
 * (or with a rotated one) used to hang on "Loading..." forever — the projects
 * mirror 401s, `isLoaded` never flips, and an installed iOS PWA has no way to
 * re-enter a token (`#token=` needs an editable URL). This screen renders in
 * place of the workspace loading state while the web auth gate reports
 * `unauthorized`: paste the token, submit, and bootstrap continues.
 *
 * Storage parity: the submitted token is persisted exactly like the
 * `#token=` URL-fragment flow (localStorage + session cache via
 * `web-auth-gate.ts` → `setWebAuthToken`), so reloads keep working. The
 * token is never logged or echoed anywhere.
 *
 * Desktop never renders this (the gate resolves `ok` immediately in
 * `checkWebAuthGate`). Web-only by construction, no `isTauriContext()` gate
 * needed inside.
 */

import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { logFrontendError } from '@/lib/log-api'
import { submitWebAuthToken, useWebAuthGate } from '@/lib/web-auth-gate'

export function WebTokenGateScreen(): React.JSX.Element {
  const gate = useWebAuthGate()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = token.trim()
    if (trimmed.length === 0 || gate.submitting) {
      setError('Enter the access token from your server.')
      return
    }
    setError(null)
    try {
      const outcome = await submitWebAuthToken(trimmed)
      if (outcome === 'invalid') {
        setError('Invalid token — check and try again.')
      } else if (outcome === 'error') {
        // Transport problem: the token may be fine; keep the form usable.
        setError('Could not reach the server. Try again.')
      }
      // 'ok' → the gate flips to ok; WorkspaceLayout re-renders into the
      // normal bootstrap path (the loader re-fetches with the new token).
    } catch (err) {
      // Defensive: submitWebAuthToken never throws, but the boundary keeps
      // the form alive no matter what.
      void logFrontendError({
        level: 'warn',
        message: err instanceof Error ? err.message : String(err),
        source: 'WebTokenGateScreen'
      })
      setError('Could not reach the server. Try again.')
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-hidden bg-background px-6">
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          void handleSubmit(event)
        }}
        aria-label="Server access token"
      >
        <div className="flex flex-col gap-1.5 text-center">
          <h1 className="text-lg font-semibold text-foreground">Server access token required</h1>
          <p className="text-sm text-muted-foreground">
            This Termul server requires a token. Paste the token from your bootstrap link or server
            console.
          </p>
        </div>
        <Input
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          aria-label="Access token"
          placeholder="Paste token"
          onChange={(e) => setToken(e.target.value)}
          disabled={gate.submitting}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={gate.submitting || gate.status === 'checking'}>
          {gate.submitting ? <Spinner size={16} decorative className="mr-2" /> : null}
          {gate.submitting ? 'Verifying…' : 'Continue'}
        </Button>
      </form>
    </div>
  )
}
