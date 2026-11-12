import { LIMITS, timeoutError } from './checks'
import { ChoiceField, PickerField, SecondsField } from './fields'
import { type FormProps, NamedTemplates } from './node-forms'
import { type McpServerChoice, useMcpServers, useMcpTools } from './sources'

export function McpToolForm({ id, spec, commit, scope }: FormProps<'mcp_tool'>): React.JSX.Element {
  const { loaded, servers } = useMcpServers()
  const server = servers.find((candidate) => candidate.id === spec.server_id)
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
        value={spec.tool}
        onChange={(tool) => commit({ ...spec, tool })}
      />
      <NamedTemplates
        id={`${id}-arguments`}
        label="Arguments"
        noun="Argument"
        help="The tool's input, one key per argument. A value that is a single {{ }} keeps its type."
        items={spec.arguments}
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
  value,
  onChange
}: {
  id: string
  server: McpServerChoice | undefined
  value: string
  onChange: (tool: string) => void
}): React.JSX.Element {
  const list = useMcpTools(server?.id ?? '')
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
