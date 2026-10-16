import type { ClaudeAccount, ClaudeAccountUsage } from '@shared/types/claude-accounts.types'
import { useEffect, useId, useState } from 'react'
import { AlertCircle, ArrowRight, Check, Globe, RotateCcw } from '@/components/icons'
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
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { claudeAccountsApi, isClaudeLoginCancelled } from '@/lib/claude-accounts-api'
import { planLabel, primaryUsageWindow, usageWindowLabel } from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'

const MAX_NAME_CHARS = 40
const NAME_SUGGESTIONS = ['Work', 'Personal', 'Team']

type Step = 'name' | 'signing' | 'done' | 'failed'

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function Steps({ step }: { step: Step }): React.JSX.Element {
  const index = step === 'name' ? 0 : step === 'done' ? 2 : 1
  const steps = ['Name', 'Sign in', 'Done']
  return (
    <ol className="flex items-center gap-1.5" aria-label="Steps">
      {steps.map((label, i) => (
        <li
          key={label}
          className="flex items-center gap-1.5"
          aria-current={i === index ? 'step' : undefined}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-full text-4xs font-semibold tabular-nums',
              i < index && 'bg-foreground text-background',
              i === index && 'bg-muted text-foreground ring-1 ring-inset ring-muted-foreground',
              i > index && 'text-muted-foreground ring-1 ring-inset ring-border'
            )}
          >
            {i < index ? <Check size={10} /> : i + 1}
          </span>
          <span
            className={cn(
              'text-2xs',
              i <= index ? 'text-secondary-foreground' : 'text-muted-foreground'
            )}
          >
            {label}
          </span>
          {i < steps.length - 1 && <span aria-hidden="true" className="h-px w-4 bg-border" />}
        </li>
      ))}
    </ol>
  )
}

function Glyph({
  tone,
  children
}: {
  tone: 'muted' | 'success' | 'warning'
  children: React.ReactNode
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg',
        tone === 'muted' && 'bg-muted text-secondary-foreground',
        tone === 'success' && 'bg-success/15 text-success',
        tone === 'warning' && 'bg-warning/15 text-warning'
      )}
    >
      {children}
    </span>
  )
}

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Names already in use, so suggestions skip them. */
  existingNames: string[]
  defaultAccountName: string | null
  /** Latest usage reads, to summarise the new Account when it is ready. */
  usage: Record<string, ClaudeAccountUsage>
  /** Called after the Account list changed (created, signed in, default). */
  onChanged: () => Promise<void>
  /** Read the new Account's usage after it signed in. */
  onSignedIn: (account: ClaudeAccount) => Promise<void>
}

/**
 * "Add account" as one dialog that stays open through the browser sign-in:
 * Name → Sign in → Done (or a failed step with Try again).
 */
export function AddAccountDialog({
  open,
  onOpenChange,
  existingNames,
  defaultAccountName,
  usage,
  onChanged,
  onSignedIn
}: AddAccountDialogProps): React.JSX.Element {
  const inputId = useId()
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [account, setAccount] = useState<ClaudeAccount | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setStep('name')
      setName('')
      setAccount(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  const signIn = async (target: ClaudeAccount): Promise<void> => {
    setStep('signing')
    setError(null)
    try {
      await claudeAccountsApi.login(target.id)
      await onChanged()
      await onSignedIn(target)
      setStep('done')
    } catch (err) {
      if (isClaudeLoginCancelled(err)) return
      setError(errorText(err))
      setStep('failed')
    }
  }

  const submitName = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await claudeAccountsApi.add(trimmed)
      setAccount(created)
      await onChanged()
      void signIn(created)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (step === 'signing' && account) void claudeAccountsApi.cancelLogin(account.id)
    onOpenChange(false)
  }

  const makeDefault = async (): Promise<void> => {
    if (!account) return
    setBusy(true)
    try {
      await claudeAccountsApi.setDefault(account.id)
      await onChanged()
      onOpenChange(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const read = account ? usage[account.id] : undefined
  const primary = primaryUsageWindow(read)
  const suggestions = NAME_SUGGESTIONS.filter(
    (suggestion) => !existingNames.some((used) => used.toLowerCase() === suggestion.toLowerCase())
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="gap-5 sm:max-w-[400px]">
        {step !== 'failed' && <Steps step={step} />}

        {step === 'name' && (
          <>
            <DialogHeader>
              <DialogTitle>Add a Claude account</DialogTitle>
              <DialogDescription>
                Give it a short name. Termul shows this name, never the email.
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitName()
              }}
            >
              <Label htmlFor={inputId} className="text-xs">
                Name
              </Label>
              <Input
                id={inputId}
                value={name}
                maxLength={MAX_NAME_CHARS}
                autoFocus
                placeholder="e.g. Work"
                onChange={(event) => setName(event.target.value)}
                className="h-9"
              />
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      size="xs"
                      variant="secondary"
                      onClick={() => setName(suggestion)}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </form>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submitName()} disabled={busy}>
                {busy ? 'Adding…' : 'Continue'}
                {!busy && <ArrowRight />}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'signing' && account && (
          <>
            <DialogHeader className="flex-row items-start gap-3 space-y-0 text-left">
              <Glyph tone="muted">
                <Globe size={15} />
              </Glyph>
              <div className="flex flex-col gap-1">
                <DialogTitle>Sign in to {account.name}</DialogTitle>
                <DialogDescription>
                  Your browser opened claude.ai. Sign in with the account you want to add, then come
                  back here.
                </DialogDescription>
              </div>
            </DialogHeader>
            <div
              role="status"
              className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-secondary-foreground"
            >
              <Spinner size={14} decorative />
              Waiting for the sign-in…
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Already signed in to another account on claude.ai? Sign out there first, or open the
              sign-in page in a private window.
            </p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'done' && account && (
          <>
            <DialogHeader className="flex-row items-start gap-3 space-y-0 text-left">
              <Glyph tone="success">
                <Check size={15} />
              </Glyph>
              <div className="flex flex-col gap-1">
                <DialogTitle>{account.name} is ready</DialogTitle>
                <DialogDescription>
                  New chats in projects that use {account.name} sign in with it.
                </DialogDescription>
              </div>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-background p-3 text-2xs">
              <dt className="text-muted-foreground">Plan</dt>
              <dd className="text-right text-secondary-foreground">
                {planLabel(read?.subscriptionType ?? null) ?? '—'}
              </dd>
              <dt className="text-muted-foreground">
                {primary ? usageWindowLabel(primary) : 'Usage'}
              </dt>
              <dd className="text-right tabular-nums text-secondary-foreground">
                {primary ? `${Math.round(primary.percent)}% used` : 'not started'}
              </dd>
              <dt className="text-muted-foreground">Default</dt>
              <dd className="text-right text-secondary-foreground">
                {defaultAccountName ? `No — ${defaultAccountName} stays default` : 'No'}
              </dd>
            </dl>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => void makeDefault()} disabled={busy}>
                Make default
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'failed' && account && (
          <>
            <DialogHeader className="flex-row items-start gap-3 space-y-0 text-left">
              <Glyph tone="warning">
                <AlertCircle size={15} />
              </Glyph>
              <div className="flex flex-col gap-1">
                <DialogTitle>Sign-in did not finish</DialogTitle>
                <DialogDescription>
                  {error ?? 'The browser window closed or timed out.'} {account.name} stays in your
                  list, signed out.
                </DialogDescription>
              </div>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button size="sm" onClick={() => void signIn(account)}>
                <RotateCcw />
                Try again
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
