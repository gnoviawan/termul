import type { Automation, AutomationId } from '@shared/types/automation.types'
import { Workflow } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import {
  automationState,
  formatDateTime,
  STATE_PRESENTATION,
  STATUS_PRESENTATION,
  triggerSummary
} from './automation-format'

export const EMPTY_EXAMPLE = 'every weekday at 9, summarize open PRs'

interface AutomationListProps {
  automations: Automation[]
  selectedId: AutomationId | null
  onSelect: (id: AutomationId) => void
}

export function AutomationList({
  automations,
  selectedId,
  onSelect
}: AutomationListProps): React.JSX.Element {
  if (automations.length === 0) return <AutomationListEmpty />
  return (
    <ul className="flex flex-col gap-1 p-2" aria-label="Automations">
      {automations.map((automation) => (
        <li key={automation.id}>
          <AutomationRow
            automation={automation}
            selected={automation.id === selectedId}
            onSelect={() => onSelect(automation.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function AutomationRow({
  automation,
  selected,
  onSelect
}: {
  automation: Automation
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const state = STATE_PRESENTATION[automationState(automation)]
  const last = automation.last_run
  const unseen = automation.unseen_failures

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex min-h-11 w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors duration-150',
        selected ? 'keycap' : 'hover:bg-foreground/[0.03]',
        FOCUS_RING_CLASS
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{automation.name}</span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded-full px-2 text-3xs font-medium leading-5',
            state.className
          )}
        >
          {state.label}
        </span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {triggerSummary(automation.trigger)}
      </span>
      <span className="flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
        <span>
          {automation.next_run_at === null
            ? 'No next run'
            : `Next ${formatDateTime(automation.next_run_at)}`}
        </span>
        {last ? (
          <span>
            Last run{' '}
            <span className={STATUS_PRESENTATION[last.status].className}>
              {STATUS_PRESENTATION[last.status].label.toLowerCase()}
            </span>
          </span>
        ) : (
          <span>Never run</span>
        )}
        {unseen > 0 && (
          <span
            className="shrink-0 rounded-full bg-destructive/20 px-1.5 text-3xs font-medium tabular-nums leading-5 text-destructive"
            data-testid="unseen-failures"
          >
            {unseen} new {unseen === 1 ? 'failure' : 'failures'}
          </span>
        )}
      </span>
    </button>
  )
}

export function AutomationListEmpty(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <Workflow size={24} className="text-muted-foreground" />
      <div className="flex max-w-xs flex-col gap-1">
        <p className="text-sm font-medium text-foreground">No automations yet</p>
        <p className="text-xs text-muted-foreground">
          Automations are built in chat. Ask an agent, for example: “{EMPTY_EXAMPLE}”. It shows up
          here for you to review and approve.
        </p>
      </div>
    </div>
  )
}
