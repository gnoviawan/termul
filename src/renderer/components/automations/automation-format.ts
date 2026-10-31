import type {
  Automation,
  AutomationNode,
  NodeKind,
  NodeSpec,
  RunStatus,
  StepStatus,
  Trigger
} from '@shared/types/automation.types'
import { Bot, Braces, GitBranch, Globe, XCircle } from '@/components/icons'

/** What the list and the header show; needs-approval wins because it asks the user to act. */
export type AutomationState = 'needs_approval' | 'disabled' | 'armed'

export function automationState(automation: Automation): AutomationState {
  if (automation.approved_revision !== automation.revision) return 'needs_approval'
  return automation.enabled ? 'armed' : 'disabled'
}

export const STATE_PRESENTATION: Record<AutomationState, { label: string; className: string }> = {
  armed: { label: 'Armed', className: 'bg-success/20 text-success' },
  needs_approval: { label: 'Needs approval', className: 'bg-warning/20 text-warning' },
  disabled: { label: 'Disabled', className: 'bg-muted text-muted-foreground' }
}

export const STATUS_PRESENTATION: Record<
  RunStatus | StepStatus,
  { label: string; className: string }
> = {
  running: { label: 'Running', className: 'text-primary' },
  succeeded: { label: 'Succeeded', className: 'text-success' },
  failed: { label: 'Failed', className: 'text-destructive' },
  cancelled: { label: 'Cancelled', className: 'text-muted-foreground' },
  skipped: { label: 'Skipped', className: 'text-muted-foreground' }
}

export const NODE_KIND_PRESENTATION: Record<NodeKind, { label: string; Icon: typeof Globe }> = {
  http: { label: 'HTTP', Icon: Globe },
  agent: { label: 'Agent', Icon: Bot },
  transform: { label: 'Transform', Icon: Braces },
  condition: { label: 'Condition', Icon: GitBranch },
  fail: { label: 'Fail', Icon: XCircle }
}

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}
const DATE_TIME = new Intl.DateTimeFormat(undefined, DATE_TIME_OPTIONS)
const DATE_TIME_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  ...DATE_TIME_OPTIONS,
  year: 'numeric'
})

/**
 * Local wall-clock time, e.g. "Mon, Oct 30, 9:00 AM", with the year when it
 * is not the current one ("Mon, Jan 4, 2027, 9:00 AM").
 */
export function formatDateTime(ms: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear()
  return (sameYear ? DATE_TIME : DATE_TIME_WITH_YEAR).format(ms)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} ${days === 1 ? 'day' : 'days'}`
}

export function triggerSummary(trigger: Trigger): string {
  if (trigger.kind === 'manual') return 'Run manually'
  const { schedule } = trigger
  switch (schedule.kind) {
    case 'cron':
      return `Cron ${schedule.expr} (${schedule.timezone})`
    case 'every':
      return `Every ${formatDuration(schedule.every_ms)}`
    case 'at':
      return `Once at ${formatDateTime(schedule.at)}`
  }
}

function urlHost(url: string): string {
  // A templated host stays as written; the runtime checks it against allowed_hosts.
  if (url.includes('{{') && !/^https?:\/\/[^/{]+[/?#]?/.test(url)) return url
  try {
    return new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).host
  } catch {
    return url
  }
}

/** The one line a diagram card shows under the label. */
export function nodeKeyDetail(spec: NodeSpec): string {
  switch (spec.kind) {
    case 'http':
      return `${spec.method} ${urlHost(spec.url)}`
    case 'agent':
      return spec.model ? `${spec.agent_id} · ${spec.model}` : spec.agent_id
    case 'transform':
      return spec.fields.map((field) => field.name).join(', ') || 'No fields'
    case 'condition':
      return [spec.left, spec.op, spec.right].filter(Boolean).join(' ')
    case 'fail':
      return spec.message
  }
}

export function nodeLabels(nodes: AutomationNode[]): Map<string, string> {
  return new Map(nodes.map((node) => [node.id, node.label]))
}
