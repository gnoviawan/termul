import type { Automation, Issue, RunPolicy } from '@shared/types/automation.types'
import { AlertTriangle, ShieldCheck } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { formatDateTime, formatDuration, nodeLabels } from './automation-format'

interface RunPolicyCardProps {
  automation: Automation
  policy: RunPolicy
  issues: Issue[]
  approving: boolean
  onApprove: () => void
}

/**
 * What the automation will do once armed, exactly as the host derived it
 * (`RunPolicy`). Approval arms the revision on screen; it is refused while
 * the graph has issues.
 */
export function RunPolicyCard({
  automation,
  policy,
  issues,
  approving,
  onApprove
}: RunPolicyCardProps): React.JSX.Element {
  const labels = nodeLabels(automation.graph.nodes)
  const labelOf = (nodeId: string): string => labels.get(nodeId) ?? nodeId
  const needsApproval = automation.approved_revision !== automation.revision

  return (
    <section
      aria-labelledby="automation-run-policy"
      className="rounded-xl border border-border bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ShieldCheck size={16} className="shrink-0 text-muted-foreground" />
        <h3 id="automation-run-policy" className="text-sm font-medium text-foreground">
          Run policy
        </h3>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          Revision {automation.revision}
        </span>
      </header>

      <dl className="divide-y divide-border text-sm">
        <PolicyRow term="Trigger">{policy.trigger_summary}</PolicyRow>
        <PolicyRow term="Next runs">
          {policy.next_runs.length === 0 ? (
            <span className="text-muted-foreground">None scheduled</span>
          ) : (
            <ul className="flex flex-col gap-0.5 tabular-nums">
              {policy.next_runs.slice(0, 3).map((at) => (
                <li key={at}>{formatDateTime(at)}</li>
              ))}
            </ul>
          )}
        </PolicyRow>
        <PolicyRow term="Agents">
          {policy.agents.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {policy.agents.map((agent) => (
                <li key={agent.node_id}>
                  <span className="text-foreground">{labelOf(agent.node_id)}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {agent.agent_id}
                    {agent.model ? ` (${agent.model})` : ''}
                    {` · times out after ${formatDuration(agent.timeout_ms)}`}
                    {agent.tools === 'none' ? ' · no tools' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PolicyRow>
        <PolicyRow term="Secrets">
          <PerNodeList
            entries={policy.secrets.map((entry) => ({ nodeId: entry.node_id, items: entry.names }))}
            labelOf={labelOf}
          />
        </PolicyRow>
        <PolicyRow term="Outbound hosts">
          <PerNodeList
            entries={policy.outbound_hosts.map((entry) => ({
              nodeId: entry.node_id,
              items: entry.hosts
            }))}
            labelOf={labelOf}
          />
        </PolicyRow>
        <PolicyRow term="On failure">{policy.failure_policy}</PolicyRow>
      </dl>

      {policy.untrusted_flow && (
        <p className="mx-4 mb-3 flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          An agent reads content fetched from the web, and a later step sends data out. Fetched
          pages can carry instructions, so check the outbound hosts before you approve.
        </p>
      )}

      {needsApproval && (
        <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center">
          <p className="flex-1 text-xs text-muted-foreground">
            {issues.length > 0
              ? 'Fix the issues above before approving. Ask the agent that built it to fix them.'
              : automation.approved_revision === null
                ? 'Not approved yet. It will not run until you approve this revision.'
                : `Revision ${automation.approved_revision} was approved. This revision needs your approval before it runs again.`}
          </p>
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            disabled={issues.length > 0 || approving}
            onClick={onApprove}
          >
            {approving ? 'Approving…' : 'Approve and arm'}
          </Button>
        </footer>
      )}
    </section>
  )
}

function PolicyRow({
  term,
  children
}: {
  term: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt className="text-xs text-muted-foreground sm:pt-0.5">{term}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  )
}

function PerNodeList({
  entries,
  labelOf
}: {
  entries: { nodeId: string; items: string[] }[]
  labelOf: (nodeId: string) => string
}): React.JSX.Element {
  if (entries.length === 0) return <span className="text-muted-foreground">None</span>
  return (
    <ul className="flex flex-col gap-1">
      {entries.map((entry) => (
        <li key={entry.nodeId} className="flex flex-wrap items-center gap-1">
          <span className="mr-1">{labelOf(entry.nodeId)}</span>
          {entry.items.map((item) => (
            <code
              key={item}
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-2xs text-secondary-foreground"
            >
              {item}
            </code>
          ))}
        </li>
      ))}
    </ul>
  )
}
