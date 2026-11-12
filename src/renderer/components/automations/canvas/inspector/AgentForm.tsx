import type { AgentTool, JsonSchemaSubset } from '@shared/types/automation.types'
import { useState } from 'react'
import { AlertCircle, AlertTriangle, ChevronRight, Plus } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AGENT_TOOL_LABELS } from '../../automation-format'
import { SAVING_MESSAGE } from '../draft/use-draft'
import { AGENT_TOOLS, agentToolRules } from './agent-tools'
import { LIMITS, maxAttemptsError, timeoutError } from './checks'
import {
  ChoiceField,
  describedBy,
  Field,
  NumberField,
  SecondsField,
  TemplateField,
  useFieldText
} from './fields'
import { type FormProps, NameRow, taking } from './node-forms'
import {
  freshFieldName,
  ofKind,
  outputSchemaError,
  SCHEMA_KINDS,
  type SchemaField,
  type SchemaKind,
  schemaFields,
  withFields,
  withoutStaleEnum
} from './output-schema'
import { useAgentModels, useKnownAgents } from './sources'

/** The model select's value for `model: null`; a select item needs a non-empty value. */
const DEFAULT_MODEL = '\u0000default'

const toolList = (tools: readonly AgentTool[]): string =>
  tools.map((tool) => AGENT_TOOL_LABELS[tool]).join(', ')

export function AgentForm({
  id,
  spec,
  commit,
  scope,
  graph,
  nodeId
}: FormProps<'agent'>): React.JSX.Element {
  return (
    <>
      <div className="grid grid-cols-2 items-start gap-2.5">
        <AgentPicker
          id={`${id}-agent`}
          value={spec.agent_id}
          onChange={(agent_id) => commit({ ...spec, agent_id, model: null })}
        />
        <ModelPicker
          id={`${id}-model`}
          agentId={spec.agent_id}
          value={spec.model}
          onChange={(model) => commit({ ...spec, model })}
        />
      </div>
      <TemplateField
        id={`${id}-prompt`}
        label="Prompt"
        value={spec.prompt}
        placeholder="What should the agent do?"
        help="Type {{ to insert a value from an earlier step."
        scope={scope}
        multiline
        commit={taking((prompt) => commit({ ...spec, prompt }))}
      />
      <OutputSchemaSection
        id={`${id}-schema`}
        schema={spec.output_schema}
        commit={(output_schema) => commit({ ...spec, output_schema })}
      />
      <ToolSwitches
        id={`${id}-tools`}
        tools={spec.tools}
        rules={agentToolRules(graph, nodeId, spec.tools)}
        commit={(tools) => commit({ ...spec, tools })}
      />
      <div className="grid grid-cols-2 items-start gap-2.5">
        <SecondsField
          id={`${id}-timeout`}
          label="Timeout"
          value={spec.timeout_ms}
          error={timeoutError(spec.timeout_ms, LIMITS.agentMaxTimeoutMs)}
          commit={(timeout_ms) => commit({ ...spec, timeout_ms })}
        />
        <NumberField
          id={`${id}-attempts`}
          label="Max attempts"
          value={spec.max_attempts}
          error={maxAttemptsError(spec.max_attempts)}
          commit={(max_attempts) => commit({ ...spec, max_attempts })}
        />
      </div>
    </>
  )
}

function AgentPicker({
  id,
  value,
  onChange
}: {
  id: string
  value: string
  onChange: (agentId: string) => void
}): React.JSX.Element {
  const known = useKnownAgents()
  const agents = known.state === 'ready' ? known.agents : []
  const listed = agents.some((agent) => agent.agent_id === value)
  const options = agents.map((agent) => ({ value: agent.agent_id, label: agent.name }))
  if (value && !listed) options.push({ value, label: value })
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ChoiceField
        id={id}
        label="Agent"
        value={value}
        options={options}
        disabled={known.state === 'loading'}
        placeholder={known.state === 'loading' ? 'Loading…' : 'Pick an agent'}
        error={
          known.state === 'error'
            ? `Could not list the agents: ${known.error}`
            : agents.length > 0 && value && !listed
              ? 'Not a known agent. Start it once in a chat.'
              : null
        }
        help={
          known.state === 'ready' && agents.length === 0
            ? 'No agents yet. Start one once in a chat and it shows here.'
            : undefined
        }
        onChange={onChange}
      />
      {known.state === 'error' && (
        <Button variant="outline" size="xs" className="self-start" onClick={known.retry}>
          Retry
        </Button>
      )}
    </div>
  )
}

function ModelPicker({
  id,
  agentId,
  value,
  onChange
}: {
  id: string
  agentId: string
  value: string | null
  onChange: (model: string | null) => void
}): React.JSX.Element {
  const models = useAgentModels(agentId)
  const options = [
    { value: DEFAULT_MODEL, label: 'Default' },
    ...models.map((model) => ({ value: model.modelId, label: model.name }))
  ]
  if (value !== null && !models.some((model) => model.modelId === value)) {
    options.push({ value, label: value })
  }
  return (
    <ChoiceField
      id={id}
      label="Model"
      value={value ?? DEFAULT_MODEL}
      options={options}
      help={
        agentId && models.length === 0
          ? 'Run this agent once in a chat to list its models.'
          : undefined
      }
      onChange={(next) => onChange(next === DEFAULT_MODEL ? null : next)}
    />
  )
}

function ToolSwitches({
  id,
  tools,
  rules,
  commit
}: {
  id: string
  tools: readonly AgentTool[]
  rules: ReturnType<typeof agentToolRules>
  commit: (tools: AgentTool[]) => boolean
}): React.JSX.Element {
  return (
    <fieldset className="flex min-w-0 flex-col">
      <legend className="mb-1 text-xs font-medium">Tools</legend>
      {AGENT_TOOLS.map((tool) => {
        const on = tools.includes(tool)
        return (
          <div
            key={tool}
            className="flex h-7 items-center justify-between gap-3 pointer-coarse:h-11"
          >
            <Label
              htmlFor={`${id}-${tool}`}
              className={cn('text-sm font-normal', !on && 'text-muted-foreground')}
            >
              {AGENT_TOOL_LABELS[tool]}
            </Label>
            <Switch
              id={`${id}-${tool}`}
              checked={on}
              onCheckedChange={(checked) =>
                commit(AGENT_TOOLS.filter((t) => (t === tool ? checked : tools.includes(t))))
              }
            />
          </div>
        )
      })}
      {rules.untrustedPrompt.length > 0 && (
        <p className="mt-2 flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>
            This agent's prompt reads untrusted data (an http response, an MCP tool result, or the
            output of an agent that can fetch, run commands or use other tools), so it may not use:{' '}
            {toolList(rules.untrustedPrompt)}.
          </span>
        </p>
      )}
      {rules.outboundFiles && (
        <p className="mt-2 flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>
            This agent can take in untrusted data with {toolList(rules.outboundFiles.outbound)}, so
            it may not also use: {toolList(rules.outboundFiles.files)}.
          </span>
        </p>
      )}
      {rules.untrustedFlow && (
        <p className="mt-2 flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>
            This agent reads content fetched from the web or returned by an MCP tool, and a later
            step sends data out or calls a tool. Fetched pages can carry instructions, so check the
            outbound hosts and MCP tools before you approve.
          </span>
        </p>
      )}
    </fieldset>
  )
}

const KIND_OPTIONS = SCHEMA_KINDS.map((kind) => ({ value: kind, label: kind }))
const ANY_ITEM = 'any'

function OutputSchemaSection({
  id,
  schema,
  commit
}: {
  id: string
  schema: JsonSchemaSubset
  commit: (schema: JsonSchemaSubset) => boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [cleared, setCleared] = useState(false)
  const problem = outputSchemaError(schema)
  /** A field or item edit; an enum the new shape no longer fits is cleared, and says so. */
  const reshape = (next: JsonSchemaSubset): boolean => {
    const fixed = withoutStaleEnum(next)
    const taken = commit(fixed.schema)
    if (taken) setCleared(fixed.cleared)
    return taken
  }
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((was) => !was)}
        className="-mx-1 flex h-7 items-center justify-between rounded-md px-1 text-sm text-secondary-foreground hover:text-foreground pointer-coarse:h-11"
      >
        <span className="flex items-center gap-1.5">
          <ChevronRight
            size={16}
            className={cn(
              'text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90'
            )}
          />
          Output schema
        </span>
        <span className="text-xs text-muted-foreground">kind: {schema.type}</span>
      </button>
      {problem && (
        <p className="text-xs text-destructive">The host refuses this schema: {problem}</p>
      )}
      {open && (
        <div id={`${id}-body`} className="flex min-w-0 flex-col gap-3">
          <ChoiceField
            id={`${id}-kind`}
            label="Kind"
            value={schema.type}
            options={KIND_OPTIONS}
            help="What the agent must answer with."
            onChange={(kind) => {
              if (commit(ofKind(kind, schema.description))) setCleared(false)
            }}
          />
          {cleared && (
            <p className="text-xs text-muted-foreground">
              The enum no longer fit this shape, so it was cleared. Set it again under As JSON.
            </p>
          )}
          {/* The controls read a valid schema; a refused one is repaired as JSON. */}
          {!problem && schema.type === 'object' && (
            <SchemaFields id={id} schema={schema} commit={reshape} />
          )}
          {!problem && schema.type === 'array' && (
            <ChoiceField
              id={`${id}-items`}
              label="Each item"
              value={schema.items?.type ?? ANY_ITEM}
              options={[{ value: ANY_ITEM, label: 'anything' }, ...KIND_OPTIONS]}
              onChange={(kind) => {
                const { items: _items, ...rest } = schema
                reshape(kind === ANY_ITEM ? rest : { ...rest, items: ofKind(kind as SchemaKind) })
              }}
            />
          )}
          <SchemaJson
            id={`${id}-json`}
            schema={schema}
            commit={(next) => {
              const taken = commit(next)
              if (taken) setCleared(false)
              return taken
            }}
          />
        </div>
      )}
    </section>
  )
}

function SchemaFields({
  id,
  schema,
  commit
}: {
  id: string
  schema: JsonSchemaSubset
  commit: (schema: JsonSchemaSubset) => boolean
}): React.JSX.Element {
  const fields = schemaFields(schema)
  const save = (next: SchemaField[]) => commit(withFields(schema, next))
  const replace = (index: number, field: SchemaField) =>
    save(fields.map((existing, i) => (i === index ? field : existing)))
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1.5 text-xs font-medium">Fields</legend>
      {fields.map((field, index) => (
        <div key={field.name} className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <NameRow
            id={`${id}-field-${index}`}
            label={`Field ${field.name} name`}
            removeLabel={`Remove field ${field.name}`}
            value={field.name}
            error={null}
            check={(text) => {
              const name = text.trim()
              if (name === '') return 'Needs a name'
              return fields.some((other, i) => i !== index && other.name === name)
                ? `${name} is already used`
                : null
            }}
            commit={(name) => replace(index, { ...field, name: name.trim() })}
            onRemove={() => save(fields.filter((_, i) => i !== index))}
          />
          <div className="grid grid-cols-[1fr_auto] items-end gap-2.5">
            <ChoiceField
              id={`${id}-field-${index}-kind`}
              label={`${field.name} kind`}
              labelHidden
              value={field.schema.type}
              options={KIND_OPTIONS}
              onChange={(kind) =>
                replace(index, { ...field, schema: ofKind(kind, field.schema.description) })
              }
            />
            <div className="flex h-9 items-center gap-2 pointer-coarse:h-11">
              <Switch
                id={`${id}-field-${index}-required`}
                aria-label={`${field.name} required`}
                checked={field.required}
                onCheckedChange={(required) => replace(index, { ...field, required })}
              />
              <Label htmlFor={`${id}-field-${index}-required`} className="text-xs font-normal">
                Required
              </Label>
            </div>
          </div>
        </div>
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() =>
          save([
            ...fields,
            { name: freshFieldName(fields), schema: { type: 'string' }, required: true }
          ])
        }
      >
        <Plus size={14} />
        Add field
      </Button>
    </fieldset>
  )
}

/** The whole schema as JSON, for what the controls above do not reach: enum, description, nesting. */
function SchemaJson({
  id,
  schema,
  commit
}: {
  id: string
  schema: JsonSchemaSubset
  commit: (schema: JsonSchemaSubset) => boolean
}): React.JSX.Element {
  const field = useFieldText(JSON.stringify(schema, null, 2), (text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return 'Not valid JSON'
    }
    const problem = outputSchemaError(parsed)
    if (problem) return problem
    const same = JSON.stringify(parsed) === JSON.stringify(schema)
    return same || commit(parsed as JsonSchemaSubset) ? null : SAVING_MESSAGE
  })
  const help = 'Also sets enum, description and nested fields. Saves when you leave the field.'
  return (
    <Field id={id} label="As JSON" error={field.error} help={help}>
      <Textarea
        id={id}
        value={field.text}
        rows={4}
        spellCheck={false}
        className="min-h-[88px] resize-y font-mono text-xs pointer-coarse:text-base"
        {...describedBy(id, field.error, help)}
        onChange={(event) => field.setText(event.target.value)}
        onBlur={field.save}
        onKeyDown={(event) => field.onKeyDown(event, event.metaKey || event.ctrlKey)}
      />
    </Field>
  )
}
