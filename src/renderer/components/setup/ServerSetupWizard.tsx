/**
 * Web onboarding / reconfigure wizard for `termul-server` (gh-1105).
 *
 * A fresh `termul-server` boots a minimal setup mode (health + `/setup/*` +
 * this SPA — no app stack). This wizard is the friendly front of it: plain-
 * language questions ("Where can Termul be reached?" rather than "bind
 * host"), server-provided defaults, and per-field errors inline so nothing
 * is saved until every answer is valid.
 *
 * Two modes share one form:
 * - `setup` — full-screen first run. Defaults come from
 *   `webSetupApi.getStatus()`; submitting runs `validate` (dry run → inline
 *   per-field errors) then `apply`.
 * - `reconfigure` — embedded in Preferences → Server. Current answers come
 *   from `webSetupApi.getServerConfig()` (or the `initial` prop); submitting
 *   runs `validate` then `applyServerConfig`. The Server page is web-only —
 *   a desktop app has no `termul-server` to reconfigure.
 *
 * Mirroring the CLI `onboard` wizard: `allowRemoteWrites` is only asked when
 * the bind is `0.0.0.0` (a documented no-op on loopback — switching back
 * resets it to false), and the update-check interval is only asked when an
 * update channel is picked. The collapsed "Advanced options" section holds
 * `sessionsDir` / `projectsFile` / `updateIntervalSecs`.
 *
 * A successful apply replies `{host, port, webAuthToken?}` and the server
 * re-execs ~400ms later — the form swaps to {@link RestartingScreen}, which
 * polls the new `/health` and lands the browser on the new origin
 * (`#token=` when a token was issued).
 */

import type {
  ServerSetupAnswers,
  ServerUpdateChannel,
  SetupApplyResponse,
  SetupFieldErrors
} from '@shared/types/server-setup.types'
import { type FormEvent, useEffect, useState } from 'react'
import { ChevronDown } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { webSetupApi } from '@/lib/web-setup-api'
import { RestartingScreen } from './RestartingScreen'

export interface ServerSetupWizardProps {
  mode: 'setup' | 'reconfigure'
  /** Pre-filled answers; when given, no fetch is made (test/section seam). */
  initial?: ServerSetupAnswers
}

/** The only hosts the server accepts (`BindMode::parse` → `display_host`). */
type BindHost = '127.0.0.1' | '0.0.0.0'

const LOG_SOURCE = 'ServerSetupWizard'

/**
 * Map any accepted host spelling (`localhost`/`loopback`/`all`/`any`, the
 * canonical `127.0.0.1`/`0.0.0.0`) onto the two bind modes — same set
 * `BindMode::parse` accepts on the server. Anything unrecognized resolves to
 * loopback, the safest reading.
 */
export function normalizeSetupHost(host: string): BindHost {
  const h = host.trim().toLowerCase()
  return h === '0.0.0.0' || h === 'all' || h === 'any' ? '0.0.0.0' : '127.0.0.1'
}

/** Coerce raw API answers into the form's normalized shape. */
function normalizeAnswers(answers: ServerSetupAnswers): ServerSetupAnswers {
  const host = normalizeSetupHost(answers.host)
  return {
    ...answers,
    host,
    // CLI parity (`OnboardAnswers::to_server_config`): remote writes only
    // ever applies to a non-loopback bind — a loopback answer keeps `false`.
    allowRemoteWrites: host === '0.0.0.0' ? answers.allowRemoteWrites : false
  }
}

function fieldErrorId(id: string): string {
  return `${id}-error`
}

/** Hint id + error id (when set) for `aria-describedby`. */
function describedBy(...ids: Array<string | false | undefined>): string | undefined {
  const list = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return list.length > 0 ? list.join(' ') : undefined
}

function FieldError({ id, message }: { id: string; message?: string }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  )
}

const CHANNEL_OPTIONS: Array<{ value: 'none' | ServerUpdateChannel; label: string }> = [
  { value: 'none', label: "Don't check for updates" },
  { value: 'stable', label: 'Stable' },
  { value: 'insider', label: 'Insider' },
  { value: 'nightly', label: 'Nightly' }
]

const CHANNEL_HINTS: Record<'none' | ServerUpdateChannel, string> = {
  none: 'Termul will not look for new versions.',
  stable: 'Recommended — finished, tested releases.',
  insider: 'New features a little earlier, with occasional rough edges.',
  nightly: 'The very latest changes every day — expect breakage.'
}

export function ServerSetupWizard({
  mode,
  initial
}: ServerSetupWizardProps): React.JSX.Element | null {
  const [answers, setAnswers] = useState<ServerSetupAnswers | null>(
    initial ? normalizeAnswers(initial) : null
  )
  const [loading, setLoading] = useState(initial === undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [fieldErrors, setFieldErrors] = useState<SetupFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [applied, setApplied] = useState<SetupApplyResponse | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // `initial` seeds the form without a fetch; otherwise pull the server-side
  // defaults (setup) or current answers (reconfigure).
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally re-runs the load (Try again button)
  useEffect(() => {
    if (initial !== undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    const fail = (detail: string): void => {
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `${mode} answer load failed: ${detail}`
      })
      setLoadError('Could not load the server settings. Check your connection and try again.')
      setLoading(false)
    }
    const seed = (source: ServerSetupAnswers): void => {
      setAnswers(normalizeAnswers(source))
      setLoading(false)
    }
    if (mode === 'setup') {
      void webSetupApi
        .getStatus()
        .then((res) => {
          if (cancelled) return
          if (res.success) {
            seed(res.data.defaults)
          } else {
            fail(`getStatus code ${res.code}`)
          }
        })
        .catch((err) => {
          if (cancelled) return
          fail(err instanceof Error ? err.message : String(err))
        })
    } else {
      void webSetupApi
        .getServerConfig()
        .then((res) => {
          if (cancelled) return
          if (res.success) {
            seed(res.data.config)
          } else {
            fail(`getServerConfig code ${res.code}`)
          }
        })
        .catch((err) => {
          if (cancelled) return
          fail(err instanceof Error ? err.message : String(err))
        })
    }
    return () => {
      cancelled = true
    }
  }, [mode, initial, retry])

  const update = <K extends keyof ServerSetupAnswers>(
    key: K,
    value: ServerSetupAnswers[K]
  ): void => {
    setAnswers((prev) => (prev ? { ...prev, [key]: value } : prev))
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev))
    setFormError(null)
  }

  const handleHostChange = (value: string): void => {
    const host = normalizeSetupHost(value)
    setAnswers((prev) =>
      prev
        ? {
            ...prev,
            host,
            // Mirror the CLI's conditional ask: remote writes is skipped (a
            // no-op) on loopback, so a stale "on" can't leak into the answers.
            allowRemoteWrites: host === '0.0.0.0' ? prev.allowRemoteWrites : false
          }
        : prev
    )
    setFieldErrors((prev) => ({ ...prev, host: undefined, allowRemoteWrites: undefined }))
    setFormError(null)
  }

  const handleChannelChange = (value: string): void => {
    update('updateChannel', value === 'none' ? null : (value as ServerUpdateChannel))
  }

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!answers || submitting) return
    setFormError(null)
    if (!Number.isInteger(answers.port) || answers.port < 1 || answers.port > 65535) {
      setFieldErrors((prev) => ({ ...prev, port: 'Enter a whole number between 1 and 65535.' }))
      return
    }
    setSubmitting(true)
    try {
      // The server's dry run reuses the CLI validators — its per-field
      // errors land inline under each control.
      const check = await webSetupApi.validate(answers)
      if (!check.success) {
        setFormError('Could not reach the server. Check the connection and try again.')
        return
      }
      if (!check.data.ok) {
        setFieldErrors(check.data.fieldErrors ?? {})
        return
      }
      const result =
        mode === 'setup'
          ? await webSetupApi.apply(answers)
          : await webSetupApi.applyServerConfig(answers)
      if (!result.success) {
        void logFrontendError({
          level: 'warn',
          source: LOG_SOURCE,
          message: `${mode} apply failed (code ${result.code})`
        })
        setFormError(result.error || 'The server rejected these settings. Try again.')
        return
      }
      // The server can still refuse at apply time (e.g. a field turned
      // invalid between the dry-run and the submit) — it answers the same
      // `{ok:false, fieldErrors}` verdict, surfaced inline per field.
      if (result.data.ok === false) {
        setFieldErrors(result.data.fieldErrors ?? {})
        return
      }
      // Boundary log (AGENTS.md): host/port + whether a token was issued —
      // never the token itself.
      void logFrontendError({
        level: 'info',
        source: LOG_SOURCE,
        message: `server setup applied; restarting on ${result.data.host}:${result.data.port} (web auth token ${result.data.webAuthToken ? 'issued' : 'not issued'})`
      })
      setApplied(result.data)
    } finally {
      setSubmitting(false)
    }
  }

  if (applied) {
    return (
      <RestartingScreen
        host={applied.host}
        port={applied.port}
        webAuthToken={applied.webAuthToken}
      />
    )
  }

  const loadingBody = (
    <div className="flex items-center justify-center py-8">
      <Spinner label="Loading server settings" />
    </div>
  )

  const errorBody = (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <p role="alert" className="text-sm text-destructive">
        {loadError}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
        Try again
      </Button>
    </div>
  )

  const form =
    answers === null ? null : (
      <>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="server-setup-host">Where can Termul be reached?</Label>
          <Select value={answers.host} onValueChange={handleHostChange} disabled={submitting}>
            <SelectTrigger
              id="server-setup-host"
              aria-describedby={describedBy(
                'server-setup-host-hint',
                fieldErrors.host && fieldErrorId('server-setup-host')
              )}
              aria-invalid={fieldErrors.host ? true : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="127.0.0.1">Only this computer</SelectItem>
              <SelectItem value="0.0.0.0">Other devices on the network</SelectItem>
            </SelectContent>
          </Select>
          <p id="server-setup-host-hint" className="text-xs text-muted-foreground">
            {answers.host === '0.0.0.0'
              ? 'Phones, tablets and computers that can reach this machine will be able to connect.'
              : 'Safest — nothing else on the network can connect.'}
          </p>
          <FieldError id={fieldErrorId('server-setup-host')} message={fieldErrors.host} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="server-setup-port">Port</Label>
          <Input
            id="server-setup-port"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={Number.isFinite(answers.port) ? answers.port : ''}
            onChange={(e) => update('port', e.target.valueAsNumber)}
            disabled={submitting}
            aria-describedby={describedBy(
              'server-setup-port-hint',
              fieldErrors.port && fieldErrorId('server-setup-port')
            )}
            aria-invalid={fieldErrors.port ? true : undefined}
          />
          <p id="server-setup-port-hint" className="text-xs text-muted-foreground">
            The part after the colon in the address — like <span className="font-mono">:8080</span>.
            The default works for most people.
          </p>
          <FieldError id={fieldErrorId('server-setup-port')} message={fieldErrors.port} />
        </div>

        {answers.host === '0.0.0.0' ? (
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label id="server-setup-remote-writes-label" htmlFor="server-setup-remote-writes">
                Let other devices make changes
              </Label>
              <p id="server-setup-remote-writes-hint" className="text-xs text-muted-foreground">
                When off, other devices can watch terminals and browse files but can't type or edit.
              </p>
              <FieldError
                id={fieldErrorId('server-setup-remote-writes')}
                message={fieldErrors.allowRemoteWrites}
              />
            </div>
            <Switch
              id="server-setup-remote-writes"
              aria-labelledby="server-setup-remote-writes-label"
              checked={answers.allowRemoteWrites}
              onCheckedChange={(checked) => update('allowRemoteWrites', checked)}
              disabled={submitting}
              aria-describedby={describedBy(
                'server-setup-remote-writes-hint',
                fieldErrors.allowRemoteWrites && fieldErrorId('server-setup-remote-writes')
              )}
              aria-invalid={fieldErrors.allowRemoteWrites ? true : undefined}
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="server-setup-channel">Updates</Label>
          <Select
            value={answers.updateChannel ?? 'none'}
            onValueChange={handleChannelChange}
            disabled={submitting}
          >
            <SelectTrigger
              id="server-setup-channel"
              aria-describedby={describedBy(
                'server-setup-channel-hint',
                fieldErrors.updateChannel && fieldErrorId('server-setup-channel')
              )}
              aria-invalid={fieldErrors.updateChannel ? true : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id="server-setup-channel-hint" className="text-xs text-muted-foreground">
            {CHANNEL_HINTS[answers.updateChannel ?? 'none']}
          </p>
          <FieldError
            id={fieldErrorId('server-setup-channel')}
            message={fieldErrors.updateChannel}
          />
        </div>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start">
              <ChevronDown
                className={cn(
                  'transition-transform duration-150 ease-out',
                  advancedOpen && 'rotate-180'
                )}
              />
              Advanced options
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-4 pt-2">
            <p className="text-xs text-muted-foreground">Most people never need these.</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="server-setup-sessions-dir">Folder for terminal data</Label>
              <Input
                id="server-setup-sessions-dir"
                type="text"
                className="font-mono"
                value={answers.sessionsDir}
                onChange={(e) => update('sessionsDir', e.target.value)}
                disabled={submitting}
                aria-describedby={describedBy(
                  'server-setup-sessions-dir-hint',
                  fieldErrors.sessionsDir && fieldErrorId('server-setup-sessions-dir')
                )}
                aria-invalid={fieldErrors.sessionsDir ? true : undefined}
                spellCheck={false}
              />
              <p id="server-setup-sessions-dir-hint" className="text-xs text-muted-foreground">
                Where Termul keeps terminal sessions.
              </p>
              <FieldError
                id={fieldErrorId('server-setup-sessions-dir')}
                message={fieldErrors.sessionsDir}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="server-setup-projects-file">Projects list file</Label>
              <Input
                id="server-setup-projects-file"
                type="text"
                className="font-mono"
                value={answers.projectsFile}
                onChange={(e) => update('projectsFile', e.target.value)}
                disabled={submitting}
                aria-describedby={describedBy(
                  'server-setup-projects-file-hint',
                  fieldErrors.projectsFile && fieldErrorId('server-setup-projects-file')
                )}
                aria-invalid={fieldErrors.projectsFile ? true : undefined}
                spellCheck={false}
              />
              <p id="server-setup-projects-file-hint" className="text-xs text-muted-foreground">
                Where Termul stores your project list.
              </p>
              <FieldError
                id={fieldErrorId('server-setup-projects-file')}
                message={fieldErrors.projectsFile}
              />
            </div>
            {answers.updateChannel !== null ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="server-setup-update-interval">How often to check for updates</Label>
                <Input
                  id="server-setup-update-interval"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={
                    Number.isFinite(answers.updateIntervalSecs) ? answers.updateIntervalSecs : ''
                  }
                  onChange={(e) => update('updateIntervalSecs', e.target.valueAsNumber)}
                  disabled={submitting}
                  aria-describedby={describedBy(
                    'server-setup-update-interval-hint',
                    fieldErrors.updateIntervalSecs && fieldErrorId('server-setup-update-interval')
                  )}
                  aria-invalid={fieldErrors.updateIntervalSecs ? true : undefined}
                />
                <p id="server-setup-update-interval-hint" className="text-xs text-muted-foreground">
                  Seconds between checks — 21600 is every 6 hours.
                </p>
                <FieldError
                  id={fieldErrorId('server-setup-update-interval')}
                  message={fieldErrors.updateIntervalSecs}
                />
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <Button type="submit" disabled={submitting}>
          {submitting ? <Spinner size={16} decorative className="mr-2" /> : null}
          {submitting ? 'Saving…' : mode === 'setup' ? 'Start Termul' : 'Save and restart'}
        </Button>
      </>
    )

  if (mode === 'setup') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center overflow-y-auto bg-background px-6 py-10">
        {loading ? (
          loadingBody
        ) : loadError ? (
          errorBody
        ) : (
          <form
            className="flex w-full max-w-md flex-col gap-5"
            aria-label="Set up Termul"
            noValidate
            onSubmit={(event) => {
              void handleSubmit(event)
            }}
          >
            <div className="flex flex-col gap-1.5 text-center">
              <h1 className="text-lg font-semibold text-foreground">Set up Termul</h1>
              <p className="text-sm text-muted-foreground">
                A few questions and you're in — the defaults work for most people.
              </p>
            </div>
            {form}
          </form>
        )}
      </div>
    )
  }

  // Reconfigure: embedded inside the Server preferences page — the section
  // provides the surrounding chrome, the wizard is just the form.
  if (loading) return loadingBody
  if (loadError) return errorBody
  return (
    <form
      className="flex max-w-md flex-col gap-5"
      aria-label="Server settings"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
    >
      {form}
    </form>
  )
}
