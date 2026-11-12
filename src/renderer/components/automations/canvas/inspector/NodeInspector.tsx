import type {
  AutomationNode,
  Graph,
  Issue,
  NodeKind,
  NodeSpec
} from '@shared/types/automation.types'
import { useMemo } from 'react'
import { AlertCircle, Trash2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { NODE_KIND_PRESENTATION } from '../../automation-format'
import { SAVING_MESSAGE } from '../draft/use-draft'
import { TextField } from './fields'
import { type FormProps, NODE_FORMS } from './node-forms'
import { templateScope } from './template-scope'

/** The floating panel's width and its gap from the canvas edges. */
const PANEL = { width: 344, gap: 12 } as const

/** What the floating inspector covers at the canvas's right edge. */
export const INSPECTOR_INSET = PANEL.width + PANEL.gap

/**
 * The inspector's frame: on desktop and in the browser a panel floating at
 * the canvas's right edge, on the phone a sheet under the canvas. Header
 * (icon, title, kind and id, delete, close), the fields, and the dry run's
 * issues on what it inspects.
 */
export function InspectorPanel({
  phone,
  Icon,
  title,
  kind,
  id,
  issues,
  refusal = null,
  onDelete,
  onClose,
  children
}: {
  phone: boolean
  Icon: typeof X
  title: string
  kind: string
  id: string
  issues: readonly Issue[]
  /** Why the host refuses the pending edits; the phone sheet shows it in place of the dock. */
  refusal?: string | null
  onDelete?: () => void
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useOverlayRegistration('automation-inspector', phone, onClose, { mobileShellOnly: true })
  const button = phone ? 'touch' : 'icon-sm'
  return (
    <aside
      aria-label={`Inspect ${title}`}
      data-testid="automation-inspector"
      className={cn(
        'z-20 flex flex-col overflow-hidden border-border bg-card shadow-panel',
        phone
          ? 'max-h-[60%] shrink-0 rounded-t-2xl border-t'
          : 'absolute max-h-[calc(100%-1.5rem)] rounded-xl border'
      )}
      style={phone ? undefined : { top: PANEL.gap, right: PANEL.gap, width: PANEL.width }}
    >
      {phone && (
        <span aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-field-border" />
      )}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border py-2.5 pr-2 pl-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-secondary-foreground">
          <Icon size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {kind} · <span className="font-mono">{id}</span>
          </p>
        </div>
        {onDelete && (
          <Button
            variant="ghost"
            size={button}
            className={cn(phone && 'w-11')}
            aria-label="Delete step"
            title="Delete step"
            onClick={onDelete}
          >
            <Trash2 size={16} />
          </Button>
        )}
        <Button
          variant="ghost"
          size={button}
          className={cn(phone && 'w-11')}
          aria-label="Close the inspector"
          title="Close"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
        {children}
      </div>
      <section
        aria-label="Issues on this step"
        className="flex max-h-40 shrink-0 flex-col gap-1.5 overflow-y-auto border-t border-border px-4 pt-3 pb-3.5"
      >
        {refusal && (
          <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">The host refuses these edits: {refusal}</span>
          </p>
        )}
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">Issues on this step</span>
          <span className="tabular-nums text-muted-foreground">{issues.length}</span>
        </div>
        {issues.length === 0 ? (
          <p className="text-xs text-muted-foreground">No issues on {title}.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li
                // Issues carry no id; the same code can repeat on one step.
                key={`${issue.code}-${index}`}
                className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <AlertCircle size={14} className="mt-px shrink-0" />
                <span className="min-w-0 break-words">{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

/** What an edit changes on a step; the editor sends it as one `update_node`. */
export type NodeChange = { label: string } | { spec: NodeSpec }

/** The inspector for one step: its label, then the form for its kind. */
export function NodeInspector({
  node,
  graph,
  issues,
  refusal,
  phone,
  locked,
  onChange,
  onDelete,
  onClose
}: {
  node: AutomationNode
  /** The draft graph: templates may reference the steps that run before this one. */
  graph: Graph
  issues: readonly Issue[]
  refusal: string | null
  phone: boolean
  /** Save is running; edits wait for it. */
  locked: boolean
  /** False when the draft did not take the edit. */
  onChange: (change: NodeChange) => boolean
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const scope = useMemo(() => templateScope(graph, node.id), [graph, node.id])
  const { label, Icon } = NODE_KIND_PRESENTATION[node.spec.kind]
  const Form = NODE_FORMS[node.spec.kind] as (props: FormProps<NodeKind>) => React.JSX.Element
  const prefix = `inspect-${node.id}`
  return (
    <InspectorPanel
      phone={phone}
      Icon={Icon}
      title={node.label}
      kind={label}
      id={node.id}
      issues={issues}
      refusal={refusal}
      onDelete={locked ? undefined : onDelete}
      onClose={onClose}
    >
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
        <TextField
          id={`${prefix}-label`}
          label="Label"
          value={node.label}
          commit={(text) => {
            const next = text.trim()
            if (next === '') return 'A step needs a label'
            if (next === node.label || onChange({ label: next })) return null
            return SAVING_MESSAGE
          }}
        />
        <Form
          id={prefix}
          spec={node.spec}
          scope={scope}
          commit={(spec) =>
            JSON.stringify(spec) === JSON.stringify(node.spec) || onChange({ spec })
          }
        />
      </fieldset>
    </InspectorPanel>
  )
}
