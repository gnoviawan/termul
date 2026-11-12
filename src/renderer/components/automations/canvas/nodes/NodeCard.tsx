import type { AutomationNode, NodeSpec, Port, Trigger } from '@shared/types/automation.types'
import { Clock, Zap } from '@/components/icons'
import { cn } from '@/lib/utils'
import {
  formatDuration,
  NODE_KIND_PRESENTATION,
  nodeKeyDetail,
  triggerSummary
} from '../../automation-format'
import { CARD, HANDLE_SIZE, OUTPUT_PORTS, outputPortY, PORT_PRESENTATION, TRIGGER } from '../ports'

export type CardData =
  | { kind: typeof TRIGGER; trigger: Trigger }
  | { kind: 'step'; node: AutomationNode }

type Slot = { label: string; value: string }

/**
 * The short detail a 192 px card has room for. What a slot already shows
 * (model, tools, MCP tool) is left out; the step list keeps the full detail.
 */
function cardDetail(spec: NodeSpec): string {
  switch (spec.kind) {
    case 'http':
      return nodeKeyDetail(spec)
    case 'agent':
      return spec.agent_id
    case 'transform':
      return spec.fields.length === 1 ? '1 field' : `${spec.fields.length} fields`
    case 'condition':
      return [spec.op, spec.right].filter(Boolean).join(' ')
    case 'fail':
      return spec.message
    case 'for_each':
      return `max ${spec.max_iterations}`
    case 'merge':
      return spec.mode === 'all' ? 'every branch' : 'any branch'
    case 'wait':
      return formatDuration(spec.duration_ms)
    case 'approval':
      return `times out after ${formatDuration(spec.timeout_ms)}`
    case 'mcp_tool':
      return spec.server_id
  }
}

/** Config slots an agent or MCP tool card hangs below itself. */
function slotsOf(spec: NodeSpec): Slot[] {
  switch (spec.kind) {
    case 'agent':
      return [
        { label: 'Model', value: spec.model ?? 'Default' },
        { label: 'Tools', value: spec.tools.join(', ') || 'None' }
      ]
    case 'mcp_tool':
      return [
        { label: 'Server', value: spec.server_id },
        { label: 'Tool', value: spec.tool }
      ]
    default:
      return []
  }
}

function present(data: CardData): {
  Icon: typeof Zap
  title: string
  subtitle: string
  ports: readonly Port[]
  slots: Slot[]
} {
  if (data.kind === TRIGGER) {
    const manual = data.trigger.kind === 'manual'
    return {
      Icon: manual ? Zap : Clock,
      title: manual ? 'Manual' : 'Schedule',
      subtitle: triggerSummary(data.trigger),
      ports: OUTPUT_PORTS.trigger,
      slots: []
    }
  }
  const { spec, label } = data.node
  const kind = NODE_KIND_PRESENTATION[spec.kind]
  return {
    Icon: kind.Icon,
    title: label,
    subtitle: `${kind.label} · ${cardDetail(spec)}`,
    ports: OUTPUT_PORTS[spec.kind],
    slots: slotsOf(spec)
  }
}

/**
 * One step on the canvas: icon tile, title, kind and key detail, the names
 * of ports labelled beside their handle, and config slots under agent and
 * MCP tool cards. Handles come from the flow adapter as `children`. The
 * canvas reads the same steps out as a list, so the card is hidden from
 * screen readers.
 */
export function NodeCard({
  data,
  selected,
  children
}: {
  data: CardData
  selected: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const { Icon, title, subtitle, ports, slots } = present(data)
  return (
    <div className="relative" style={{ width: CARD.width, height: CARD.height }}>
      <div
        aria-hidden="true"
        className={cn(
          'flex size-full items-center gap-2 rounded-xl border pr-1.5 pl-2.5 shadow-xs',
          selected ? 'keycap border-foreground/40' : 'border-border bg-card'
        )}
      >
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-lg',
            selected ? 'bg-foreground/10 text-foreground' : 'bg-muted text-secondary-foreground'
          )}
        >
          <Icon size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          <span className="truncate text-xs text-muted-foreground" title={subtitle}>
            {subtitle}
          </span>
        </span>
      </div>
      {ports.map((port, index) =>
        PORT_PRESENTATION[port].label === 'handle' ? (
          <span
            key={port}
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute -translate-y-1/2 rounded-sm bg-background px-0.5 text-xs leading-4',
              PORT_PRESENTATION[port].tone
            )}
            style={{ left: CARD.width + HANDLE_SIZE, top: outputPortY(index, ports.length) }}
          >
            {port}
          </span>
        ) : null
      )}
      {slots.map((slot, index) => (
        <span
          key={slot.label}
          aria-hidden="true"
          className="pointer-events-none absolute top-full flex w-23 -translate-x-1/2 flex-col items-center"
          style={{ left: index === 0 ? '24%' : '76%' }}
        >
          <span className="-mt-1 size-2 rotate-45 border-2 border-muted-foreground bg-card" />
          <span className="h-2.5 w-px bg-field-border" />
          <span className="max-w-full truncate rounded-full border border-border bg-card px-2 text-xs leading-[18px] font-semibold text-foreground">
            {slot.value}
          </span>
          <span className="mt-0.5 text-xs leading-4 text-muted-foreground">{slot.label}</span>
        </span>
      ))}
      {children}
    </div>
  )
}
