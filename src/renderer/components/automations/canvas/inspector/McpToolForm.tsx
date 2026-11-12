import type { NamedTemplate } from '@shared/types/automation.types'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { McpToolInfo } from '@/lib/acp-api'
import { SAVING_MESSAGE } from '../draft/use-draft'
import { LIMITS, timeoutError } from './checks'
import { ChoiceField, PickerField, SecondsField, TemplateField } from './fields'
import { type FormProps, NamedTemplates } from './node-forms'
import { type McpServerChoice, useMcpServers, useMcpTools } from './sources'
import type { TemplateSuggestion } from './template-scope'
import {
  type ArgumentField,
  argumentError,
  argumentFields,
  isTemplate,
  setArgument
} from './tool-arguments'

export function McpToolForm({ id, spec, commit, scope }: FormProps<'mcp_tool'>): React.JSX.Element {
  const { loaded, servers } = useMcpServers()
  const server = servers.find((candidate) => candidate.id === spec.server_id)
  const list = useMcpTools(server?.id ?? '')
  const tool = list.state === 'ready' ? list.tools.find((t) => t.name === spec.tool) : undefined
  const options = servers.map((candidate) => ({ value: candidate.id, label: candidate.name }))
  if (spec.server_id && !server) {
    options.push({ value: spec.server_id, label: `${spec.server_id} (not configured)` })
  }
  return (
    <>
      <ChoiceField
        id={`${id}-server`}
        label="Server"
        value={spec.server_id}
        options={options}
        placeholder="Pick a server"
        error={
          loaded && spec.server_id && !server
            ? 'Server not configured. Add it, or turn it on, in the MCP settings.'
            : null
        }
        help={
          loaded && servers.length === 0
            ? 'No MCP servers yet. Add one in the MCP settings.'
            : undefined
        }
        onChange={(server_id) => commit({ ...spec, server_id })}
      />
      <ToolPicker
        id={`${id}-tool`}
        server={server}
        list={list}
        value={spec.tool}
        onChange={(next) => commit({ ...spec, tool: next })}
      />
      <ToolArguments
        id={`${id}-arguments`}
        tool={tool}
        args={spec.arguments}
        scope={scope}
        commit={(args) => commit({ ...spec, arguments: args })}
      />
      <SecondsField
        id={`${id}-timeout`}
        label="Timeout"
        value={spec.timeout_ms}
        error={timeoutError(spec.timeout_ms, LIMITS.mcpMaxTimeoutMs)}
        commit={(timeout_ms) => commit({ ...spec, timeout_ms })}
      />
    </>
  )
}

function ToolPicker({
  id,
  server,
  list,
  value,
  onChange
}: {
  id: string
  server: McpServerChoice | undefined
  list: ReturnType<typeof useMcpTools>
  value: string
  onChange: (tool: string) => void
}): React.JSX.Element {
  const tools = list.state === 'ready' ? list.tools : []
  const picked = tools.find((tool) => tool.name === value)
  const error = !server
    ? null
    : list.state === 'failed'
      ? `${server.name} did not list its tools: ${list.error}`
      : list.state === 'ready' && value && !picked
        ? `Tool not found. ${server.name} has no tool ${value}.`
        : null
  return (
    <PickerField
      id={id}
      label="Tool"
      value={value}
      options={tools.map((tool) => ({ value: tool.name, detail: tool.description }))}
      placeholder={server ? 'Pick a tool' : 'Pick a server first'}
      disabled={!server || list.state !== 'ready'}
      error={error}
      help={
        server && list.state === 'loading'
          ? `Listing the tools of ${server.name}…`
          : picked?.description
      }
      onChange={onChange}
    />
  )
}

const ARGUMENTS_HELP =
  "The tool's input, one key per argument. A value that is a single {{ }} keeps its type."

/**
 * The picked tool's arguments: a field per property of its input schema,
 * then any argument the schema does not name. With no schema, name and
 * value rows.
 */
function ToolArguments({
  id,
  tool,
  args,
  scope,
  commit
}: {
  id: string
  tool: McpToolInfo | undefined
  args: NamedTemplate[]
  scope: readonly TemplateSuggestion[]
  commit: (args: NamedTemplate[]) => boolean
}): React.JSX.Element {
  const fields = argumentFields(tool?.inputSchema)
  if (!fields) {
    return (
      <NamedTemplates
        id={id}
        label="Arguments"
        noun="Argument"
        help={ARGUMENTS_HELP}
        items={args}
        scope={scope}
        commit={commit}
      />
    )
  }
  const named = new Set(fields.map((field) => field.name))
  const extras = args.filter((arg) => !named.has(arg.name))
  const typed = fields.some((field) => field.kind !== 'string' && field.kind !== 'enum')
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-1.5 text-xs font-medium">Arguments</legend>
      {typed && (
        <p className="-mt-1.5 text-xs text-muted-foreground">
          The host sends a typed value as text. A value that is a single {'{{ }}'} keeps its type.
        </p>
      )}
      {fields.map((field) => (
        <ArgumentInput
          key={field.name}
          id={`${id}-${field.name.replace(/[^\w-]/g, '_')}`}
          field={field}
          value={args.find((arg) => arg.name === field.name)?.value ?? ''}
          scope={scope}
          set={(value) => commit(setArgument(args, field.name, value))}
        />
      ))}
      {extras.length > 0 && (
        <NamedTemplates
          id={`${id}-other`}
          label="Not in the tool's input"
          noun="Argument"
          items={extras}
          scope={scope}
          commit={(next) => commit([...args.filter((arg) => named.has(arg.name)), ...next])}
        />
      )}
    </fieldset>
  )
}

/** The value of a select whose argument is not set; a select item needs a non-empty value. */
const UNSET = '\u0000unset'

function ArgumentInput({
  id,
  field,
  value,
  scope,
  set
}: {
  id: string
  field: ArgumentField
  value: string
  scope: readonly TemplateSuggestion[]
  /** False when the draft did not take the value. */
  set: (value: string) => boolean
}): React.JSX.Element {
  const missing = field.required && value === '' ? 'Required' : null
  if (field.kind === 'boolean' && !isTemplate(value)) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex h-7 items-center justify-between gap-3 pointer-coarse:h-11">
          <span className="flex items-baseline gap-2">
            <Label htmlFor={id} className="text-xs">
              {field.name}
            </Label>
            {field.required && <span className="text-xs text-muted-foreground">Required</span>}
          </span>
          <Switch
            id={id}
            checked={value === 'true'}
            onCheckedChange={(checked) => set(checked ? 'true' : 'false')}
          />
        </div>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    )
  }
  if (field.kind === 'enum' && (value === '' || field.options?.includes(value))) {
    const options = (field.options ?? []).map((option) => ({ value: option, label: option }))
    return (
      <ChoiceField
        id={id}
        label={field.name}
        value={value === '' && !field.required ? UNSET : value}
        options={field.required ? options : [{ value: UNSET, label: 'Not set' }, ...options]}
        placeholder="Pick one"
        required={field.required}
        error={missing}
        help={field.description}
        onChange={(next) => set(next === UNSET ? '' : next)}
      />
    )
  }
  return (
    <TemplateField
      id={id}
      label={field.name}
      value={value}
      scope={scope}
      multiline={field.kind === 'json'}
      required={field.required}
      error={missing}
      help={field.description ?? (field.kind === 'json' ? 'JSON, or a single {{ }}.' : undefined)}
      commit={(text) => {
        return argumentError(field.kind, text) ?? (set(text) ? null : SAVING_MESSAGE)
      }}
    />
  )
}
