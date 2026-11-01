import type {
  McpConsentNamespace,
  McpConsentProvenance,
  McpConsentValue,
  McpConsentView,
  McpConsentWarning,
  McpHostMount,
  McpInstallPlan
} from '@shared/types/mcp-install.types'
import { useId, useRef } from 'react'
import { toast } from 'sonner'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
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
import { openerApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/relative-time'

export const CONSENT_WARNING_COPY: Record<McpConsentWarning, string> = {
  'runs-local-code': 'This runs a program on this computer with your permissions.',
  'runs-inline-code':
    'It hands a shell or interpreter code written in its arguments. Read every argument before you approve.',
  'mounts-host-path':
    'The container can read and change the folders on this computer listed below.',
  'mounts-sensitive-path':
    'It mounts the root folder, a home folder or the Docker socket, which gives the container control of this computer.',
  'sends-data-remote': 'This sends your data to a remote server.',
  'mutable-tag': 'This image tag can change without notice.',
  deprecated: 'The registry marks this server deprecated.',
  'from-file': "These values came from a file. You didn't type them."
}

const VERBATIM_CLASS = 'whitespace-pre-wrap break-all font-mono text-xs'

interface McpConsentDialogProps {
  open: boolean
  plan: McpInstallPlan | null
  onApprove: () => void
  onCancel: () => void
  busy?: boolean
  error?: string | null
  notice?: React.ReactNode
}

export function McpConsentDialog({
  open,
  plan,
  onApprove,
  onCancel,
  busy = false,
  error = null,
  notice = null
}: McpConsentDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const verb = plan?.source.kind === 'import' ? 'Import' : 'Install'

  return (
    <Dialog
      open={open && plan !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      {plan !== null && (
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            cancelRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {verb} {plan.name}
            </DialogTitle>
            <DialogDescription>
              Review exactly what will run. Nothing is saved until you approve.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <Warnings warnings={plan.consentView.warnings} />
            <LaunchSpec view={plan.consentView} />
            <HostMounts mounts={plan.consentView.hostMounts} />
            <ValueList heading="Environment" values={plan.consentView.env} />
            <ValueList heading="Headers" values={plan.consentView.headers} />
            {plan.consentView.provenance !== null && (
              <Provenance provenance={plan.consentView.provenance} />
            )}
            <p className="break-all font-mono text-2xs text-muted-foreground">
              Launch digest {plan.launchDigest}
            </p>
          </div>

          {notice}

          {error !== null && (
            <SettingsNotice tone="danger" role="alert">
              {error}
            </SettingsNotice>
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

const DANGER_WARNINGS: ReadonlySet<McpConsentWarning> = new Set(['mounts-sensitive-path'])

function Warnings({ warnings }: { warnings: McpConsentWarning[] }): React.JSX.Element {
  const danger = warnings.filter((warning) => DANGER_WARNINGS.has(warning))
  const caution = warnings.filter((warning) => !DANGER_WARNINGS.has(warning))
  return (
    <>
      {danger.length > 0 && (
        <SettingsNotice tone="danger">
          <WarningList warnings={danger} />
        </SettingsNotice>
      )}
      {caution.length > 0 && (
        <SettingsNotice tone="warning">
          <WarningList warnings={caution} />
        </SettingsNotice>
      )}
    </>
  )
}

function WarningList({ warnings }: { warnings: McpConsentWarning[] }): React.JSX.Element {
  return (
    <ul className="grid gap-1">
      {warnings.map((warning) => (
        <li key={warning}>{CONSENT_WARNING_COPY[warning]}</li>
      ))}
    </ul>
  )
}

function HostMounts({ mounts }: { mounts: McpHostMount[] }): React.JSX.Element | null {
  if (mounts.length === 0) return null
  return (
    <Section heading="Folders from this computer">
      <ul className="grid gap-0.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
        {mounts.map((mount, index) => (
          <li key={index} className="flex flex-wrap items-center gap-1.5">
            <span className={VERBATIM_CLASS}>
              <Verbatim text={mount.hostPath} />
            </span>
            {mount.sensitive && <Badge variant="destructive">dangerous</Badge>}
          </li>
        ))}
      </ul>
    </Section>
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
            {entry.value !== null && (
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

function openRepository(url: string): void {
  void openerApi.openUrlWithSystemBrowser(url).then((result) => {
    if (!result.success) toast.error("Couldn't open the repository link.")
  })
}

function Provenance({ provenance }: { provenance: McpConsentProvenance }): React.JSX.Element {
  const repositoryUrl = provenance.repositoryUrl
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
                  openRepository(repositoryUrl)
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
        {provenance.snapshotFetchedAt !== null && (
          <>
            <dt className="text-muted-foreground">Catalog snapshot</dt>
            <dd>{snapshotAge(provenance.snapshotFetchedAt)}</dd>
          </>
        )}
      </dl>
    </Section>
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

function Verbatim({ text }: { text: string }): React.JSX.Element {
  if (text === '') return <span className="text-muted-foreground italic">(empty)</span>
  return <>{text}</>
}

function namespaceLabel(namespace: McpConsentNamespace): string {
  return namespace.kind === 'github'
    ? `GitHub account ${namespace.account}`
    : `Domain ${namespace.domain}`
}

function snapshotAge(iso: string): string {
  const relative = formatRelativeTime(iso)
  if (relative === 'now') return 'just now'
  return /^\d+[mhdw]$/.test(relative) ? `${relative} ago` : relative
}
