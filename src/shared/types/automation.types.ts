// Mirror of `src-tauri/src/automation/model.rs`. Field and tag names match the
// Rust serde names exactly; `__fixtures__/automation.json` is checked by both
// sides so the two cannot drift.

type Brand<T, B extends string> = T & { readonly __brand: B }

export type AutomationId = Brand<string, 'AutomationId'>
export type RunId = Brand<string, 'RunId'>
/** `^[a-z][a-z0-9_]{0,31}$`, never `trigger`. */
export type NodeId = Brand<string, 'NodeId'>

/** A string with `{{ path }}` holes. */
export type Template = string

export type Isolation = 'shared_in_root' | 'worktree_per_run'

export type Schedule =
  | { kind: 'cron'; expr: string; timezone: string }
  | { kind: 'every'; every_ms: number; anchor_ms: number }
  | { kind: 'at'; at: number }

export type Trigger = { kind: 'manual' } | { kind: 'schedule'; schedule: Schedule }

export type JsonSchemaSubset = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  properties?: Record<string, JsonSchemaSubset>
  required?: string[]
  items?: JsonSchemaSubset
  enum?: unknown[]
  description?: string
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type NamedTemplate = { name: string; value: Template }

export type ConditionOp = 'eq' | 'ne' | 'contains' | 'gt' | 'lt' | 'exists'

export type NodeSpec =
  | {
      kind: 'http'
      method: HttpMethod
      url: Template
      headers: NamedTemplate[]
      body: Template | null
      allowed_hosts: string[]
    }
  | {
      kind: 'agent'
      agent_id: string
      model: string | null
      prompt: Template
      output_schema: JsonSchemaSubset
      timeout_ms: number
      max_attempts: number
    }
  | { kind: 'transform'; fields: NamedTemplate[] }
  | { kind: 'condition'; left: Template; op: ConditionOp; right: Template | null }
  | { kind: 'fail'; message: Template }

export type NodeKind = NodeSpec['kind']

export type AutomationNode = { id: NodeId; label: string; spec: NodeSpec }

export type Port = 'out' | 'error' | 'true' | 'false'

export type Edge = { from: NodeId | 'trigger'; port: Port; to: NodeId }

export type Graph = { nodes: AutomationNode[]; edges: Edge[] }

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'

export type LastRun = { run_id: RunId; status: RunStatus; finished_at: number }

export type Automation = {
  id: AutomationId
  project_id: string
  name: string
  revision: number
  approved_revision: number | null
  enabled: boolean
  trigger: Trigger
  graph: Graph
  isolation: Isolation
  next_run_at: number | null
  consecutive_errors: number
  schedule_error_count: number
  unseen_failures: number
  last_run: LastRun | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export type AutomationOp =
  | { op: 'add_node'; node: AutomationNode }
  | { op: 'update_node'; id: NodeId; label?: string; spec?: NodeSpec }
  | { op: 'remove_node'; id: NodeId }
  | { op: 'connect'; edge: Edge }
  | { op: 'disconnect'; edge: Edge }
  | { op: 'set_trigger'; trigger: Trigger }
  | { op: 'rename'; name: string }
  | { op: 'set_isolation'; isolation: Isolation }

export type IssueCode =
  | 'duplicate_node_id'
  | 'unknown_edge_endpoint'
  | 'illegal_port'
  | 'trigger_edge_count'
  | 'cycle'
  | 'unreachable'
  | 'invalid_template'
  | 'unknown_node_reference'
  | 'non_ancestor_reference'
  | 'secret_not_allowed'
  | 'invalid_url'
  | 'host_not_allowed'
  | 'templated_host_without_allowlist'
  | 'invalid_output_schema'
  | 'agent_timeout_out_of_range'
  | 'agent_max_attempts_out_of_range'
  | 'missing_condition_operand'
  | 'invalid_schedule'
  | 'unknown_agent'

export type Issue = { node_id: NodeId | null; code: IssueCode; message: string }

export type ApplyOpsResult = { automation: Automation; issues: Issue[] }

export type RunTrigger = 'scheduled' | 'catch_up' | 'manual'

export type AutomationRun = {
  id: RunId
  automation_id: AutomationId
  revision: number
  /** Snapshot of the graph at `revision`. */
  graph: Graph
  trigger: RunTrigger
  scheduled_for: number
  status: RunStatus
  started_at: number
  finished_at: number | null
  stop_reason: string | null
  summary: string | null
  conversation_id: string | null
  worktree_id: string | null
}

export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped'

export type AutomationStep = {
  run_id: RunId
  node_id: NodeId
  status: StepStatus
  output: unknown
  error: string | null
  started_at: number | null
  finished_at: number | null
}

export type AgentPolicy = {
  node_id: NodeId
  agent_id: string
  model: string | null
  timeout_ms: number
  tools: 'none'
}

export type RunPolicy = {
  trigger_summary: string
  next_runs: number[]
  agents: AgentPolicy[]
  secrets: { node_id: NodeId; names: string[] }[]
  outbound_hosts: { node_id: NodeId; hosts: string[] }[]
  untrusted_flow: boolean
  failure_policy: string
}

/** An agent this host can launch for an agent node. */
export type KnownAgent = { agent_id: string; name: string }

/**
 * Wire event `automation_changed`; `automation_id` is null for project-wide changes.
 * `proposed` is present and true only when a chat agent asks the user to review it;
 * `proposed_by` is that agent's display name when the host knows it.
 */
export type AutomationChanged = {
  project_id: string
  automation_id: AutomationId | null
  proposed?: true
  proposed_by?: string
}

/** An automation with what its editor and approval card render. */
export type AutomationDetail = { automation: Automation; issues: Issue[]; policy: RunPolicy }

/** When a repeated ask usually happens: a schedule plus "weekdays at 09:00". */
export type SuggestionCadence = { schedule: Schedule; label: string }

/**
 * An ask the user repeated across chats on several days. `fingerprint` is its
 * stable id; `representative` is the latest ask, at most 300 characters.
 */
export type AutomationSuggestion = {
  fingerprint: string
  representative: string
  occurrences: number
  days: number
  last_at: number
  cadence: SuggestionCadence
}
