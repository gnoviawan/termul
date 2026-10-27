import type {
  McpConsentNamespace,
  McpConsentProvenance,
  McpConsentValue,
  McpConsentView,
  McpConsentWarning,
  McpInstallPlan
} from '@shared/types/mcp-catalog.types'
import { useId, useRef } from 'react'
import { AlertTriangle } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatRelativeTime } from '@/lib/relative-time'
import { openerApi } from '@/lib/tauri-opener-api'

export const CONSENT_WARNING_COPY: Record<McpConsentWarning, string> = {
  'runs-local-code': 'This will run a program on this computer with your permissions.',
  'sends-data-remote': 'This sends your data to a remote server.',
  'mutable-tag': 'This image tag can change without notice.',
  deprecated: 'The registry marks this server deprecated.',
  'from-file': 'These values came from a file you did not type.'
}

const VERBATIM_CLASS = 'whitespace-pre-wrap break-all font-mono text-xs'

interface McpConsentDialogProps {
  open: boolean
  plan: McpInstallPlan | null
  onApprove: () => void
  onCancel: () => void
  busy?: boolean
  error?: string | null
}

/**
 * The SEP-1024 consent view of a host-built install plan (spine AD-5). The
 * host already escaped control and bidi characters, so every string is drawn
 * as sent. Approve only fires on an explicit click; Escape, the scrim and the
 * close button cancel.
 */
export function McpConsentDialog({
  open,
  plan,
  onApprove,
  onCancel,
  busy = false,
  error = null
}: McpConsentDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open={open && plan !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      {plan !== null && (
        <DialogContent
          className="sm:max-w-[640px]"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            cancelRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Install {plan.name}</DialogTitle>
            <DialogDescription>
              Review exactly what will run. Nothing is saved until you approve.
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[60vh] gap-4 overflow-y-auto">
            <Warnings warnings={plan.consentView.warnings} />
            <LaunchSpec view={plan.consentView} />
            <ValueList heading="Environment" values={plan.consentView.env} />
            <ValueList heading="Headers" values={plan.consentView.headers} />
            {plan.consentView.provenance !== null && (
              <Provenance provenance={plan.consentView.provenance} />
            )}
            {plan.consentView.offerLiveSync && <LiveSyncOffer />}
            <p className="truncate font-mono text-2xs text-muted-foreground">
              Launch digest {plan.launchDigest}
            </p>
          </div>

          {error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={onApprove} disabled={busy}>
              {busy ? 'Installing…' : 'Approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

function Warnings({ warnings }: { warnings: McpConsentWarning[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <ul className="grid gap-1 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
      {warnings.map((warning) => (
        <li key={warning} className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {CONSENT_WARNING_COPY[warning]}
        </li>
      ))}
    </ul>
  )
}

function LaunchSpec({ view }: { view: McpConsentView }): React.JSX.Element {
  if (view.transport !== 'stdio') {
    return (
      <Section heading={`URL (${view.transport})`}>
        <p className={VERBATIM_CLASS}>{view.url}</p>
      </Section>
    )
  }
  return (
    <>
      <Section heading="Command">
        <p className={VERBATIM_CLASS}>{view.command}</p>
      </Section>
      <Section heading="Arguments">
        <ol className="grid gap-0.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
          {view.argv.map((arg, index) => (
            <li key={index} className={VERBATIM_CLASS}>
              <Verbatim text={arg} />
            </li>
          ))}
        </ol>
      </Section>
    </>
  )
}

function ValueList({
  heading,
  values
}: {
  heading: string
  values: McpConsentValue[]
}): React.JSX.Element | null {
  if (values.length === 0) return null
  return (
    <Section heading={heading}>
      <dl className="grid gap-1.5">
        {values.map((entry) => (
          <div key={entry.name} className="grid gap-0.5">
            <dt className="flex flex-wrap items-center gap-1.5">
              <span className={VERBATIM_CLASS}>{entry.name}</span>
              {entry.isSecret && <Badge variant="secondary">secret</Badge>}
              {entry.origin === 'file' && <Badge variant="outline">from file</Badge>}
            </dt>
            {!entry.isSecret && entry.value !== null && (
              <dd className={`${VERBATIM_CLASS} text-muted-foreground`}>
                <Verbatim text={entry.value} />
              </dd>
            )}
          </div>
        ))}
      </dl>
    </Section>
  )
}

function Provenance({ provenance }: { provenance: McpConsentProvenance }): React.JSX.Element {
  const repositoryUrl = provenance.repositoryUrl
  const snapshotAge =
    provenance.snapshotFetchedAt === null ? '' : formatAge(provenance.snapshotFetchedAt)
  return (
    <Section heading="Source">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Publisher</dt>
        <dd>{namespaceLabel(provenance.namespace)}</dd>
        {repositoryUrl !== null && (
          <>
            <dt className="text-muted-foreground">Repository</dt>
            <dd className="break-all">
              <a
                href={repositoryUrl}
                className="text-foreground underline underline-offset-2"
                onClick={(event) => {
                  event.preventDefault()
                  void openerApi.openUrlWithSystemBrowser(repositoryUrl)
                }}
              >
                {repositoryUrl}
              </a>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Version</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <span className="break-all font-mono">{provenance.version}</span>
          {provenance.mutableTag && <Badge variant="outline">mutable tag</Badge>}
        </dd>
        {snapshotAge !== '' && (
          <>
            <dt className="text-muted-foreground">Catalog snapshot</dt>
            <dd>{snapshotAge}</dd>
          </>
        )}
      </dl>
    </Section>
  )
}

function LiveSyncOffer(): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={false} disabled />
      <Label htmlFor={id} className="text-xs">
        Turn on live sync
      </Label>
    </div>
  )
}

function Section({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="grid gap-1.5">
      <h3 id={headingId} className="label-panel">
        {heading}
      </h3>
      {children}
    </section>
  )
}

/** An empty string would otherwise render as nothing at all. */
function Verbatim({ text }: { text: string }): React.JSX.Element {
  if (text === '') return <span className="text-muted-foreground italic">(empty)</span>
  return <>{text}</>
}

function namespaceLabel(namespace: McpConsentNamespace): string {
  return namespace.kind === 'github'
    ? `GitHub account ${namespace.account}`
    : `Domain ${namespace.domain}`
}

function formatAge(iso: string): string {
  const relative = formatRelativeTime(iso)
  if (relative === 'now') return 'just now'
  return /^\d+[mhdw]$/.test(relative) ? `${relative} ago` : relative
}
