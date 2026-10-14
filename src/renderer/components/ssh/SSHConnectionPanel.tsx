import type { SSHProfile } from '@shared/types/ssh.types'
import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Server,
  ShieldAlert,
  ShieldCheck
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconSwap } from '@/components/ui/icon-swap'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FOCUS_RING_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { copyText } from '@/lib/copy-text'
import { addressLabel, describeSSHError, SSH_STAGES, stageLabel } from '@/lib/ssh-messages'
import {
  cancelSSHSession,
  closeSSHSession,
  respondSSHHostKey,
  retrySSHSession
} from '@/lib/ssh-sessions'
import { cn } from '@/lib/utils'
import type { SSHSession } from '@/stores/ssh-store'

interface SSHConnectionPanelProps {
  session: SSHSession
  profile: SSHProfile
  onEditHost: (profile: SSHProfile) => void
}

/** Host identity shown at the top of every connection state. */
function HostHeader({ profile }: { profile: SSHProfile }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground"
        aria-hidden="true"
      >
        <Server size={18} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{profile.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{addressLabel(profile)}</p>
      </div>
    </div>
  )
}

function Progress({ session, profile }: SSHConnectionPanelProps): React.JSX.Element {
  const current = session.stage ? SSH_STAGES.indexOf(session.stage) : 0
  return (
    <>
      <ol aria-label="Connection progress">
        {SSH_STAGES.map((stage, index) => {
          const done = index < current
          const active = index === current
          const last = index === SSH_STAGES.length - 1
          return (
            <li
              key={stage}
              className="flex gap-3 text-sm"
              aria-current={active ? 'step' : undefined}
            >
              {/* Mark plus the line down to the next step. */}
              <span className="flex w-4 shrink-0 flex-col items-center" aria-hidden="true">
                <span className="flex h-5 items-center">
                  <IconSwap
                    iconKey={done ? 'done' : active ? 'active' : 'waiting'}
                    className="size-4"
                  >
                    {done ? (
                      <Check size={14} className="text-success" />
                    ) : active ? (
                      <Spinner size={13} decorative className="text-warning" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                    )}
                  </IconSwap>
                </span>
                {!last && (
                  <span
                    className={cn(
                      'min-h-2 w-px flex-1 transition-colors duration-200 ease-out',
                      done ? 'bg-success/50' : 'bg-border'
                    )}
                  />
                )}
              </span>
              <span
                className={cn(
                  'leading-5',
                  !last && 'pb-3',
                  done || active ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {stageLabel(stage, profile)}
              </span>
              <span className="sr-only">
                {done ? '(done)' : active ? '(in progress)' : '(waiting)'}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => cancelSSHSession(session.id)}
        >
          Cancel
        </Button>
      </div>
    </>
  )
}

function Fingerprint({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-foreground">
        {value}
      </code>
      <button
        type="button"
        className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6 shrink-0')}
        onClick={() => {
          void copyText(value).then((ok) => {
            // Only a copy that worked says "copied".
            if (!ok) return
            if (resetTimer.current) clearTimeout(resetTimer.current)
            setCopied(true)
            resetTimer.current = setTimeout(() => setCopied(false), 1500)
          })
        }}
        aria-label={copied ? 'Fingerprint copied' : 'Copy fingerprint'}
        title="Copy fingerprint"
      >
        <IconSwap iconKey={copied} className="size-3">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </IconSwap>
      </button>
    </div>
  )
}

function HostKeyQuestion({ session }: { session: SSHSession }): React.JSX.Element | null {
  const prompt = session.hostKeyPrompt
  if (!prompt) return null
  const target = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`
  const changed = prompt.status === 'changed'
  return (
    <section className="space-y-4" aria-labelledby={`${session.id}-hk-title`}>
      <div className="flex items-start gap-3">
        {changed ? (
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <ShieldCheck
            size={18}
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <div className="space-y-1.5">
          <h3 id={`${session.id}-hk-title`} className="text-sm font-semibold text-foreground">
            {changed ? 'Server identity changed' : 'Verify this server'}
          </h3>
          {changed ? (
            <>
              <p className="text-sm text-muted-foreground">
                {target} presented a different key than the one you trusted before. This happens
                when a server is reinstalled — or when someone intercepts the connection.
              </p>
              <p className="text-sm text-foreground">
                Continue only if you know why the key changed.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              First connection to {target}. Check that this fingerprint matches the one from the
              server&apos;s administrator, then trust it. Termul remembers it for next time.
            </p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {changed ? 'New ' : ''}
          {prompt.keyType} key fingerprint
        </p>
        <Fingerprint value={prompt.fingerprint} />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant={changed ? 'outline' : 'ghost'}
          size="sm"
          autoFocus={changed}
          onClick={() => void respondSSHHostKey(session.id, false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={changed ? 'destructive' : 'default'}
          size="sm"
          autoFocus={!changed}
          onClick={() => void respondSSHHostKey(session.id, true)}
        >
          {changed ? 'Replace key and connect' : 'Trust and connect'}
        </Button>
      </div>
    </section>
  )
}

function CredentialForm({ session, profile }: SSHConnectionPanelProps): React.JSX.Element | null {
  const prompt = session.credentialPrompt
  const [secret, setSecret] = useState('')
  const [visible, setVisible] = useState(false)
  const [save, setSave] = useState(false)
  const inputId = useId()
  const saveId = useId()
  if (!prompt) return null
  const isPassword = prompt.kind === 'password'
  const rejected = prompt.reason === 'rejected'
  const title = isPassword ? `Password for ${profile.username}` : 'Unlock private key'
  const hint = rejected
    ? isPassword
      ? 'That password was not accepted. Check it and try again.'
      : 'That passphrase did not unlock the key. Try again.'
    : isPassword
      ? `Enter the password to sign in to ${profile.host}.`
      : `${profile.privateKeyPath ?? 'The key'} is protected by a passphrase.`
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        retrySSHSession(session.id, { secret, saveSecret: save })
      }}
    >
      <div className="flex items-start gap-3">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p
            id={`${inputId}-hint`}
            className={cn('text-sm', rejected ? 'text-destructive' : 'text-muted-foreground')}
            role={rejected ? 'alert' : undefined}
          >
            {hint}
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={inputId} className="text-xs">
          {isPassword ? 'Password' : 'Passphrase'}
        </Label>
        <div className="relative">
          <Input
            id={inputId}
            type={visible ? 'text' : 'password'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-invalid={rejected}
            aria-describedby={`${inputId}-hint`}
            className="h-9 pr-9"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className={cn(
              'absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground',
              FOCUS_RING_CLASS
            )}
            aria-label={visible ? 'Hide' : 'Show'}
            aria-pressed={visible}
          >
            {visible ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch id={saveId} checked={save} onCheckedChange={setSave} />
        <Label htmlFor={saveId} className="text-xs font-normal text-muted-foreground">
          Save in system keychain
        </Label>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => cancelSSHSession(session.id)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isPassword ? false : secret.length === 0}>
          Connect
        </Button>
      </div>
    </form>
  )
}

function Failure({
  session,
  profile,
  onEditHost
}: SSHConnectionPanelProps): React.JSX.Element | null {
  const error = session.error
  if (!error) return null
  const message = describeSSHError(error.code, profile)
  return (
    <div className="space-y-4" role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{message.title}</h3>
          <p className="text-sm text-muted-foreground">{message.body}</p>
        </div>
      </div>
      {error.detail && error.code !== 'SSH_CANCELLED' && (
        <details className="group rounded-lg border border-border bg-background px-3 py-2">
          <summary className={cn('cursor-pointer text-xs text-muted-foreground', FOCUS_RING_CLASS)}>
            Technical details
          </summary>
          <code className="mt-1.5 block select-all break-all font-mono text-2xs text-muted-foreground">
            {error.code}: {error.detail}
          </code>
        </details>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void closeSSHSession(session.id)}
        >
          Close tab
        </Button>
        {message.suggestEdit && (
          <Button type="button" variant="outline" size="sm" onClick={() => onEditHost(profile)}>
            Edit host
          </Button>
        )}
        <Button type="button" size="sm" autoFocus onClick={() => retrySSHSession(session.id)}>
          Try again
        </Button>
      </div>
    </div>
  )
}

/** Everything a session tab shows before its shell is ready. */
export function SSHConnectionPanel(props: SSHConnectionPanelProps): React.JSX.Element {
  const { session } = props
  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto p-6">
      <div
        className="w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-5"
        data-testid="ssh-connection-panel"
        data-status={session.status}
      >
        <HostHeader profile={props.profile} />
        {session.hostKeyPrompt ? (
          <HostKeyQuestion session={session} />
        ) : session.credentialPrompt ? (
          <CredentialForm key={session.attemptId} {...props} />
        ) : session.status === 'failed' ? (
          <Failure {...props} />
        ) : (
          <Progress {...props} />
        )}
      </div>
    </div>
  )
}
