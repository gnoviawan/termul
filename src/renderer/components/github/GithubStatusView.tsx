import type { GithubAuthStatus, GithubContext } from '@shared/types/github.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmedExternalLink } from '@/components/external-link/ExternalLinkConfirm'
import { AlertTriangle, Check, Copy, Github } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/copy-text'

const GH_INSTALL_URL = 'https://cli.github.com'

/** Why the list cannot show, in the order that decides what the user must fix first. */
export type GithubBlocker =
  | { kind: 'cli_missing' }
  | { kind: 'not_github' }
  | { kind: 'unauthenticated'; host: string; loginCommand: string }

export function githubBlocker(context: GithubContext): GithubBlocker | null {
  if (context.auth.state === 'cli_missing') return { kind: 'cli_missing' }
  // Signing in cannot help a project whose remote is not on GitHub.
  if (context.repo.kind === 'not_github') return { kind: 'not_github' }
  if (context.auth.state === 'unauthenticated') {
    return {
      kind: 'unauthenticated',
      host: context.auth.host,
      loginCommand: context.auth.loginCommand
    }
  }
  return null
}

interface GithubStatusViewProps {
  blocker: GithubBlocker
  /** Re-read the status. */
  onRetry: () => void
  retrying: boolean
  /** Open a terminal running the login command. */
  onSignIn: (loginCommand: string) => void
}

/** CAP-1 / CAP-9 onboarding: replaces the list until GitHub is usable for this project. */
export function GithubStatusView({
  blocker,
  onRetry,
  retrying,
  onSignIn
}: GithubStatusViewProps): React.JSX.Element {
  const retry = (
    <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
      {retrying ? 'Checking…' : 'Retry'}
    </Button>
  )
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <Github size={28} aria-hidden="true" className="text-muted-foreground" />
      {blocker.kind === 'cli_missing' && (
        <>
          <h3 className="text-sm font-medium text-foreground">GitHub CLI not installed</h3>
          <p className="text-xs text-muted-foreground">
            Termul reads issues and pull requests through the GitHub CLI (<code>gh</code>) on the
            machine running Termul.{' '}
            <ConfirmedExternalLink href={GH_INSTALL_URL} className="text-primary underline">
              Install it from cli.github.com
            </ConfirmedExternalLink>
            , then retry.
          </p>
          {retry}
        </>
      )}
      {blocker.kind === 'not_github' && (
        <>
          <h3 className="text-sm font-medium text-foreground">
            This project isn't a GitHub repository
          </h3>
          <p className="text-xs text-muted-foreground">
            Its git remote is missing or points to a host the GitHub CLI doesn't know.
          </p>
          {retry}
        </>
      )}
      {blocker.kind === 'unauthenticated' && (
        <>
          <h3 className="text-sm font-medium text-foreground">Sign in to {blocker.host}</h3>
          <p className="text-xs text-muted-foreground">
            Termul uses your GitHub CLI login and never stores a token. Sign in opens a terminal
            that runs:
          </p>
          <code className="max-w-full rounded-md bg-muted px-2 py-1 font-mono text-2xs text-foreground [overflow-wrap:anywhere]">
            {blocker.loginCommand}
          </code>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={() => onSignIn(blocker.loginCommand)}>
              Sign in
            </Button>
            {retry}
          </div>
        </>
      )}
    </div>
  )
}

type ConnectedAuth = Extract<GithubAuthStatus, { state: 'connected' }>

/** A connected login that still needs a fix: missing scopes, or an env token hiding the keyring login. */
export function GithubAuthWarning({ auth }: { auth: ConnectedAuth }): React.JSX.Element | null {
  const envToken = auth.tokenSource === 'env'
  if (auth.missingScopes.length === 0 && !envToken && auth.fixCommands.length === 0) return null
  return (
    <div
      role="status"
      className="mx-2 mb-2 flex shrink-0 flex-col gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning"
    >
      <p className="flex items-start gap-1.5">
        <AlertTriangle size={14} aria-hidden="true" className="mt-px shrink-0" />
        <span>
          {auth.missingScopes.length > 0 && (
            <>
              Your login on {auth.host} is missing the{' '}
              <span className="font-mono">{auth.missingScopes.join(', ')}</span>{' '}
              {auth.missingScopes.length === 1 ? 'scope' : 'scopes'}.{' '}
            </>
          )}
          {envToken && <>GH_TOKEN or GITHUB_TOKEN is set and overrides your gh login. </>}
          {auth.fixCommands.length > 0 && 'Run this to fix it:'}
        </span>
      </p>
      {auth.fixCommands.map((command) => (
        <FixCommand key={command} command={command} />
      ))}
    </div>
  )
}

function FixCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md bg-background/60 pl-2 text-foreground">
      <code className="min-w-0 flex-1 py-1 font-mono text-2xs [overflow-wrap:anywhere]">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? 'Copied' : `Copy ${command}`}
        onClick={() => {
          void copyText(command).then((ok) => {
            if (!ok) {
              toast.error('Could not copy the command')
              return
            }
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </Button>
    </div>
  )
}
