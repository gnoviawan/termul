import type {
  Graph,
  NamedTemplate,
  NodeId,
  NodeKind,
  NodeSpec
} from '@shared/types/automation.types'
import { Plus, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SAVING_MESSAGE } from '../draft/use-draft'
import {
  approvalTimeoutError,
  maxIterationsError,
  nameErrors,
  parseHosts,
  requiredError,
  urlProblem,
  waitError
} from './checks'
import {
  ChoiceField,
  DurationField,
  describedBy,
  NumberField,
  TemplateField,
  TextField,
  useFieldText
} from './fields'
import type { TemplateSuggestion } from './template-scope'

type SpecOf<K extends NodeKind> = Extract<NodeSpec, { kind: K }>

export type FormProps<K extends NodeKind> = {
  /** Prefix for the form's element ids. */
  id: string
  spec: SpecOf<K>
  /** One call is one undo step; false when the draft did not take it (Save is running). */
  commit: (spec: SpecOf<K>) => boolean
  /** What this step's templates may reference. */
  scope: readonly TemplateSuggestion[]
  /** The draft graph and this step's id, for rules that read the steps around it. */
  graph: Graph
  nodeId: NodeId
}

/** A field edit; the field keeps its text when the draft does not take it. */
export const taking =
  (apply: (text: string) => boolean) =>
  (text: string): string | null =>
    apply(text) ? null : SAVING_MESSAGE

export function HttpForm({ id, spec, commit, scope }: FormProps<'http'>): React.JSX.Element {
  const problem = urlProblem(spec.url, spec.allowed_hosts)
  return (
    <>
      <ChoiceField
        id={`${id}-method`}
        label="Method"
        value={spec.method}
        options={(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => ({
          value: method,
          label: method
        }))}
        onChange={(method) => commit({ ...spec, method })}
      />
      <div className="flex flex-col gap-1.5">
        <TemplateField
          id={`${id}-url`}
          label="URL"
          value={spec.url}
          placeholder="https://api.example.com/items"
          scope={scope}
          error={problem?.message}
          commit={taking((url) => commit({ ...spec, url }))}
        />
        {problem?.allow && (
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            onClick={() =>
              commit({ ...spec, allowed_hosts: [...spec.allowed_hosts, problem.allow as string] })
            }
          >
            Allow {problem.allow}
          </Button>
        )}
      </div>
      <TextField
        id={`${id}-hosts`}
        label="Allowed hosts"
        value={spec.allowed_hosts.join(', ')}
        placeholder="api.example.com"
        help="The only hosts this step may reach, separated by commas."
        mono
        commit={taking((text) => commit({ ...spec, allowed_hosts: parseHosts(text) }))}
      />
      <NamedTemplates
        id={`${id}-headers`}
        label="Headers"
        noun="Header"
        items={spec.headers}
        scope={scope}
        commit={(headers) => commit({ ...spec, headers })}
      />
      <TemplateField
        id={`${id}-body`}
        label="Body"
        value={spec.body ?? ''}
        placeholder="No body"
        scope={scope}
        multiline
        commit={taking((body) => commit({ ...spec, body: body === '' ? null : body }))}
      />
    </>
  )
}

export function TransformForm({
  id,
  spec,
  commit,
  scope
}: FormProps<'transform'>): React.JSX.Element {
  return (
    <NamedTemplates
      id={`${id}-fields`}
      label="Fields"
      noun="Field"
      help="Each field becomes a key of this step's output."
      items={spec.fields}
      scope={scope}
      commit={(fields) => commit({ ...spec, fields })}
    />
  )
}

const CONDITION_OPS = [
  { value: 'eq', label: 'equals' },
  { value: 'ne', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'is greater than' },
  { value: 'lt', label: 'is less than' },
  { value: 'exists', label: 'exists' }
] as const

export function ConditionForm({
  id,
  spec,
  commit,
  scope
}: FormProps<'condition'>): React.JSX.Element {
  return (
    <>
      <TemplateField
        id={`${id}-left`}
        label="Value"
        value={spec.left}
        placeholder="{{ nodes.fetch.output.status }}"
        scope={scope}
        error={requiredError(spec.left)}
        commit={taking((left) => commit({ ...spec, left }))}
      />
      <ChoiceField
        id={`${id}-op`}
        label="Check"
        value={spec.op}
        options={CONDITION_OPS}
        onChange={(op) =>
          // `exists` takes no right operand; the others need one.
          commit({ ...spec, op, right: op === 'exists' ? null : (spec.right ?? '') })
        }
      />
      {spec.op !== 'exists' && (
        <TemplateField
          id={`${id}-right`}
          label="Compared with"
          value={spec.right ?? ''}
          scope={scope}
          commit={taking((right) => commit({ ...spec, right }))}
        />
      )}
    </>
  )
}

export function FailForm({ id, spec, commit, scope }: FormProps<'fail'>): React.JSX.Element {
  return (
    <TemplateField
      id={`${id}-message`}
      label="Message"
      value={spec.message}
      help="The run stops here as failed, with this message."
      scope={scope}
      multiline
      commit={taking((message) => commit({ ...spec, message }))}
    />
  )
}

export function ForEachForm({ id, spec, commit, scope }: FormProps<'for_each'>): React.JSX.Element {
  return (
    <>
      <TemplateField
        id={`${id}-items`}
        label="Items"
        value={spec.items}
        placeholder="{{ nodes.fetch.output.items }}"
        help="A list from an earlier step. The item branch runs once per element."
        scope={scope}
        error={requiredError(spec.items)}
        commit={taking((items) => commit({ ...spec, items }))}
      />
      <NumberField
        id={`${id}-max`}
        label="Max iterations"
        value={spec.max_iterations}
        error={maxIterationsError(spec.max_iterations)}
        commit={(max_iterations) => commit({ ...spec, max_iterations })}
      />
    </>
  )
}

export function MergeForm({ id, spec, commit }: FormProps<'merge'>): React.JSX.Element {
  return (
    <ChoiceField
      id={`${id}-mode`}
      label="Continue"
      value={spec.mode}
      options={[
        { value: 'any', label: 'When any branch arrives' },
        { value: 'all', label: 'When every branch arrives' }
      ]}
      help="A merge joins two or more branches."
      onChange={(mode) => commit({ ...spec, mode })}
    />
  )
}

export function WaitForm({ id, spec, commit }: FormProps<'wait'>): React.JSX.Element {
  return (
    <DurationField
      id={`${id}-duration`}
      label="Wait for"
      value={spec.duration_ms}
      error={waitError(spec.duration_ms)}
      help="The run parks here, then continues."
      commit={(duration_ms) => commit({ ...spec, duration_ms })}
    />
  )
}

export function ApprovalForm({
  id,
  spec,
  commit,
  scope
}: FormProps<'approval'>): React.JSX.Element {
  return (
    <>
      <TemplateField
        id={`${id}-message`}
        label="Message"
        value={spec.message}
        help="What the person deciding reads."
        scope={scope}
        multiline
        commit={taking((message) => commit({ ...spec, message }))}
      />
      <DurationField
        id={`${id}-timeout`}
        label="Time out after"
        value={spec.timeout_ms}
        error={approvalTimeoutError(spec.timeout_ms)}
        help="With no answer by then, the step fails."
        commit={(timeout_ms) => commit({ ...spec, timeout_ms })}
      />
    </>
  )
}

/** Name and template rows: http headers, transform fields, MCP tool arguments. */
export function NamedTemplates({
  id,
  label,
  noun,
  help,
  items,
  scope,
  commit
}: {
  id: string
  label: string
  noun: string
  help?: string
  items: NamedTemplate[]
  scope: readonly TemplateSuggestion[]
  commit: (items: NamedTemplate[]) => boolean
}): React.JSX.Element {
  const errors = nameErrors(items)
  const replace = (index: number, item: NamedTemplate) =>
    commit(items.map((existing, i) => (i === index ? item : existing)))
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1.5 text-xs font-medium">{label}</legend>
      {items.map((item, index) => (
        <div
          // Rows have no id; a removed row's state goes with its index.
          key={index}
          className="flex flex-col gap-1.5 rounded-lg border border-border p-2"
        >
          <NameRow
            id={`${id}-${index}-name`}
            label={`${noun} ${index + 1} name`}
            removeLabel={`Remove ${noun.toLowerCase()} ${item.name || index + 1}`}
            value={item.name}
            error={errors[index]}
            commit={(name) => replace(index, { ...item, name })}
            onRemove={() => commit(items.filter((_, i) => i !== index))}
          />
          <TemplateField
            id={`${id}-${index}-value`}
            label={`${noun} ${index + 1} value`}
            labelHidden
            value={item.value}
            scope={scope}
            commit={taking((value) => replace(index, { ...item, value }))}
          />
        </div>
      ))}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() => commit([...items, { name: '', value: '' }])}
      >
        <Plus size={14} />
        Add {noun.toLowerCase()}
      </Button>
    </fieldset>
  )
}

/** A row's name field and its remove button; the field's own refusal wins over the list's check. */
export function NameRow({
  id,
  label,
  removeLabel,
  value,
  error,
  check,
  commit,
  onRemove
}: {
  id: string
  label: string
  removeLabel: string
  value: string
  error: string | null
  /** Why `name` cannot be taken at all, before the draft is asked. */
  check?: (name: string) => string | null
  commit: (name: string) => boolean
  onRemove: () => void
}): React.JSX.Element {
  const field = useFieldText(value, (text) => check?.(text) ?? taking(commit)(text))
  const shown = field.error ?? error
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          aria-label={label}
          placeholder="Name"
          value={field.text}
          className="h-9 min-w-0 flex-1 font-mono pointer-coarse:h-11"
          {...describedBy(id, shown)}
          onChange={(event) => field.setText(event.target.value)}
          onBlur={field.save}
          onKeyDown={(event) => field.onKeyDown(event)}
        />
        <Button variant="ghost" size="icon-sm" aria-label={removeLabel} onClick={onRemove}>
          <X size={14} />
        </Button>
      </div>
      {shown && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {shown}
        </p>
      )}
    </>
  )
}
