import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, Copy, ExternalLink, Link2, RotateCcw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  claudeAccountsApi,
  isClaudeLoginCancelled,
  isClaudeLoginCodeIncomplete
} from '@/lib/claude-accounts-api'
import { copyText } from '@/lib/copy-text'
import { AccountGlyph } from './AccountGlyph'

const COPIED_MS = 2000

/** The link sign-in of one Account, as the user moves through it. */
type LinkSignIn =
  | { phase: 'starting' }
  | { phase: 'awaitingCode'; url: string; error: string | null }
  | { phase: 'submitting'; url: string }
  | { phase: 'done' }
  | { phase: 'failed'; error: string }

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A pasted code with the spaces and line breaks a copy picks up removed. */
const cleanCode = (pasted: string): string => pasted.replace(/\s+/g, '')

interface LinkSignInStepProps {
  account: { id: string; name: string }
  /** The Claude CLI on the host stored the login. */
  onSignedIn: () => void
  /** The user closed the step. A running sign-in is already stopped. */
  onCancel: () => void
}

/**
 * Sign in to a Claude account from a browser client: the host hands out the
 * Claude sign-in link, the user signs in on claude.com in any browser, and
 * pastes back the code the Claude page shows. Renders a dialog's header, body
 * and footer. Leaving the step stops a sign-in that is still waiting.
 */
export function LinkSignInStep({
  account,
  onSignedIn,
  onCancel
}: LinkSignInStepProps): React.JSX.Element {
  const codeId = useId()
  const [state, setState] = useState<LinkSignIn>({ phase: 'starting' })
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Whether the host may still hold a sign-in that this step started.
  const live = useRef(false)

  const stop = useCallback((): void => {
    if (!live.current) return
    live.current = false
    void claudeAccountsApi.cancelLogin(account.id)
  }, [account.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the sign-in.
  useEffect(() => {
    let current = true
    live.current = true
    setState({ phase: 'starting' })
    setCode('')
    claudeAccountsApi.startLinkLogin(account.id).then(
      (url) => {
        if (current) setState({ phase: 'awaitingCode', url, error: null })
      },
      (error: unknown) => {
        if (!current) return
        live.current = false
        if (!isClaudeLoginCancelled(error)) setState({ phase: 'failed', error: errorText(error) })
      }
    )
    return () => {
      current = false
      stop()
    }
  }, [account.id, attempt, stop])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyLink = async (url: string): Promise<void> => {
    if (await copyText(url)) {
      setCopied(true)
      return
    }
    setState((now) =>
      now.phase === 'awaitingCode'
        ? { ...now, error: 'Could not copy the link. Select it below and copy it.' }
        : now
    )
  }

  const submit = async (): Promise<void> => {
    if (state.phase !== 'awaitingCode') return
    const { url } = state
    if (!code) {
      setState({ phase: 'awaitingCode', url, error: 'Paste the code from the Claude page.' })
      return
    }
    setState({ phase: 'submitting', url })
    try {
      await claudeAccountsApi.finishLinkLogin(account.id, code)
      live.current = false
      setState({ phase: 'done' })
      onSignedIn()
    } catch (error) {
      if (isClaudeLoginCodeIncomplete(error)) {
        setState({ phase: 'awaitingCode', url, error: errorText(error) })
        return
      }
      live.current = false
      if (!isClaudeLoginCancelled(error)) setState({ phase: 'failed', error: errorText(error) })
    }
  }

  const cancel = (): void => {
    stop()
    onCancel()
  }

  const url = state.phase === 'awaitingCode' || state.phase === 'submitting' ? state.url : null

  return (
    <>
      <DialogHeader className="flex-row items-start gap-3 space-y-0 text-left">
        <AccountGlyph tone={state.phase === 'failed' ? 'warning' : 'muted'}>
          {state.phase === 'failed' ? <AlertCircle size={15} /> : <Link2 size={15} />}
        </AccountGlyph>
        <div className="flex flex-col gap-1">
          <DialogTitle>
            {state.phase === 'failed' ? 'Sign-in did not finish' : `Sign in to ${account.name}`}
          </DialogTitle>
          <DialogDescription>
            {state.phase === 'failed'
              ? `${state.error} ${account.name} stays in your list, signed out.`
              : 'Open the sign-in page in any browser and sign in. Claude then shows a code: copy it and paste it here.'}
          </DialogDescription>
        </div>
      </DialogHeader>

      {state.phase === 'starting' && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-secondary-foreground"
        >
          <Spinner size={14} decorative />
          Getting the sign-in link…
        </div>
      )}

      {state.phase === 'done' && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-secondary-foreground"
        >
          <Spinner size={14} decorative />
          Signed in. Loading {account.name}…
        </div>
      )}

      {url && (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  Open sign-in page
                </a>
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyLink(url)}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
            <Input
              readOnly
              value={url}
              aria-label="Sign-in link"
              onFocus={(event) => event.currentTarget.select()}
              className="h-8 font-mono text-xs text-muted-foreground md:text-xs"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={codeId} className="text-xs">
              Code from the Claude page
            </Label>
            <Input
              id={codeId}
              value={code}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the code"
              disabled={state.phase === 'submitting'}
              onChange={(event) => {
                setCode(cleanCode(event.target.value))
                setState((now) => (now.phase === 'awaitingCode' ? { ...now, error: null } : now))
              }}
              className="h-9 font-mono"
            />
            {state.phase === 'awaitingCode' && state.error && (
              <p className="text-xs text-destructive">{state.error}</p>
            )}
          </div>
        </form>
      )}

      {state.phase !== 'failed' && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Already signed in to another account on claude.ai? Sign out there first, or open the
          sign-in page in a private window.
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={cancel}>
          {state.phase === 'failed' ? 'Close' : 'Cancel'}
        </Button>
        {state.phase === 'failed' ? (
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCcw />
            Start again
          </Button>
        ) : (
          <Button size="sm" onClick={() => void submit()} disabled={state.phase !== 'awaitingCode'}>
            {state.phase === 'submitting' ? 'Checking…' : 'Finish sign-in'}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
