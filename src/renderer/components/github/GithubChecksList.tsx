import type {
  GithubCheck,
  GithubCheckStatus,
  GithubChecksResult,
  GithubRepoSlot
} from '@shared/types/github.types'
import { useState } from 'react'
import { ConfirmedExternalLink } from '@/components/external-link/ExternalLinkConfirm'
import { ChevronRight, ExternalLink } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  type GithubResource,
  githubLogKey,
  resourceOf,
  useGithubStore
} from '@/stores/github-store'
import { CheckStatusIcon, checkLook } from './github-status'

/** Failures first, then what is still running, then everything that finished without failing. */
const STATUS_ORDER: Record<GithubCheckStatus, number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  success: 3,
  neutral: 4,
  skipped: 5
}

function summarize(checks: GithubCheck[]): string {
  const counts = new Map<string, number>()
  for (const check of checks) {
    const word = checkLook(check.status).label.toLowerCase()
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, n]) => `${n} ${word}`).join(', ')
}

interface GithubChecksListProps {
  cwd: string
  repo: GithubRepoSlot
  checks: GithubResource<GithubChecksResult>
}

/** CAP-4 checks: status, name and workflow; a failed Actions job unfolds to its log tail. */
export function GithubChecksList({ cwd, repo, checks }: GithubChecksListProps): React.JSX.Element {
  const rows = [...(checks.data?.checks ?? [])].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  )
  return (
    <section aria-labelledby="github-checks" className="flex flex-col gap-1.5">
      <h2 id="github-checks" className="text-sm font-medium text-foreground">
        Checks{' '}
        {rows.length > 0 && (
          <span className="font-normal tabular-nums text-muted-foreground">{summarize(rows)}</span>
        )}
      </h2>
      {checks.status === 'error' && (
        <p className="text-xs text-destructive">
          Couldn't {checks.data ? 'refresh' : 'load'} checks
          {checks.error ? `: ${checks.error}` : '.'}
        </p>
      )}
      {checks.data === null && checks.status !== 'error' && <Skeleton className="h-8 w-full" />}
      {checks.data && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">This pull request has no checks.</p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((check) => (
            <CheckRow
              // A workflow that runs on both push and pull_request repeats a job name.
              key={
                check.jobId !== null
                  ? `job-${check.jobId}`
                  : `${check.workflow ?? ''}/${check.name}`
              }
              cwd={cwd}
              repo={repo}
              check={check}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function CheckRow({
  cwd,
  repo,
  check
}: {
  cwd: string
  repo: GithubRepoSlot
  check: GithubCheck
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const canShowLog = check.status === 'failure' && check.jobId !== null
  const logId = check.jobId !== null ? `github-check-log-${check.jobId}` : undefined

  const toggle = (): void => {
    if (!open && check.jobId !== null) {
      void useGithubStore.getState().loadCheckLog(cwd, repo, check.jobId)
    }
    setOpen(!open)
  }

  return (
    <li className="min-w-0">
      <div className="flex min-h-9 min-w-0 items-center gap-2 px-2.5 py-1.5">
        <CheckStatusIcon status={check.status} />
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-1.5">
          <span className="truncate text-xs text-foreground" title={check.name}>
            {check.name}
          </span>
          {check.workflow && (
            <span className="truncate text-2xs text-muted-foreground" title={check.workflow}>
              {check.workflow}
            </span>
          )}
        </span>
        {canShowLog && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            aria-controls={logId}
            aria-label={`Log of ${check.name}`}
            onClick={toggle}
            className="shrink-0 gap-1 pointer-coarse:h-10"
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cn('transition-transform duration-150', open && 'rotate-90')}
            />
            Log
          </Button>
        )}
        {check.detailsUrl && (
          <ConfirmedExternalLink
            href={check.detailsUrl}
            aria-label={`Open ${check.name} on GitHub`}
            title="Open on GitHub"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md pointer-coarse:size-10 text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </ConfirmedExternalLink>
        )}
      </div>
      {open && check.jobId !== null && (
        <CheckLog id={logId} cwd={cwd} repo={repo} jobId={check.jobId} />
      )}
    </li>
  )
}

function CheckLog({
  id,
  cwd,
  repo,
  jobId
}: {
  id?: string
  cwd: string
  repo: GithubRepoSlot
  jobId: number
}): React.JSX.Element {
  const log = useGithubStore((s) => resourceOf(s.logs[githubLogKey(cwd, repo, jobId)]))
  return (
    <div id={id} className="px-2.5 pb-2.5">
      {log.data ? (
        <>
          {log.data.truncated && (
            <p className="pb-1 text-2xs text-muted-foreground">Last lines of the job log</p>
          )}
          <pre className="max-h-72 overflow-auto whitespace-pre rounded-md bg-muted p-2 font-mono text-2xs leading-relaxed text-foreground">
            {log.data.tail || 'The log is empty.'}
          </pre>
        </>
      ) : log.status === 'error' ? (
        <p className="text-xs text-destructive">
          Couldn't load the log{log.error ? `: ${log.error}` : '.'}
        </p>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </div>
  )
}
